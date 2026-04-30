from fastapi import FastAPI, APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field, ConfigDict
from typing import List
import uuid
from datetime import datetime, timezone
import httpx
from urllib.parse import urlparse


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# Create the main app without a prefix
app = FastAPI()

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")


# Define Models
class StatusCheck(BaseModel):
    model_config = ConfigDict(extra="ignore")  # Ignore MongoDB's _id field
    
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    client_name: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

class StatusCheckCreate(BaseModel):
    client_name: str

# Add your routes to the router instead of directly to app
@api_router.get("/")
async def root():
    return {"message": "Hello World"}

@api_router.post("/status", response_model=StatusCheck)
async def create_status_check(input: StatusCheckCreate):
    status_dict = input.model_dump()
    status_obj = StatusCheck(**status_dict)
    
    # Convert to dict and serialize datetime to ISO string for MongoDB
    doc = status_obj.model_dump()
    doc['timestamp'] = doc['timestamp'].isoformat()
    
    _ = await db.status_checks.insert_one(doc)
    return status_obj

@api_router.get("/status", response_model=List[StatusCheck])
async def get_status_checks():
    # Exclude MongoDB's _id field from the query results
    status_checks = await db.status_checks.find({}, {"_id": 0}).to_list(1000)
    
    # Convert ISO string timestamps back to datetime objects
    for check in status_checks:
        if isinstance(check['timestamp'], str):
            check['timestamp'] = datetime.fromisoformat(check['timestamp'])
    
    return status_checks


# PDF Proxy endpoint to handle CORS for external PDF URLs
class PDFProxyRequest(BaseModel):
    url: str

@api_router.post("/pdf/proxy")
async def proxy_pdf(request: PDFProxyRequest):
    """Proxy PDF files from external URLs to bypass CORS restrictions"""
    try:
        # Validate URL
        parsed = urlparse(request.url)
        if parsed.scheme not in ['http', 'https']:
            raise HTTPException(status_code=400, detail="Invalid URL scheme")
        
        # Fetch the PDF with headers that mimic a browser
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/pdf,*/*',
        }
        
        async with httpx.AsyncClient(follow_redirects=True, timeout=60.0) as http_client:
            response = await http_client.get(request.url, headers=headers)
            
            # Accept 200, 202, and other success-ish codes
            if response.status_code not in [200, 201, 202, 203, 204]:
                logger.error(f"PDF fetch failed with status {response.status_code}")
                raise HTTPException(status_code=response.status_code, detail=f"Failed to fetch PDF: HTTP {response.status_code}")
            
            # Check if we actually got content
            if len(response.content) == 0:
                raise HTTPException(status_code=400, detail="Empty response from URL")
            
            # Return the PDF content as a streaming response
            return StreamingResponse(
                iter([response.content]),
                media_type="application/pdf",
                headers={
                    "Content-Disposition": "inline; filename=document.pdf",
                    "Access-Control-Allow-Origin": "*"
                }
            )
    except httpx.RequestError as e:
        logger.error(f"PDF proxy error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch PDF: {str(e)}")

# Include the router in the main app
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
# AgriScope - District-Level Crop Yield Prediction & Agro-Climatic Analytics

AgriScope is a full-stack agricultural analytics and pre-season crop yield forecasting platform built for Andhra Pradesh districts, combining historical agricultural records, soil profiles, weather indicators, and machine learning models (ExtraTrees and Ridge regression).

## Project Structure

- **01_Data_Collection/**: Raw agricultural, weather, and soil datasets.
- **02_Integrated_Data/ & 03_Integrated_Data/**: Cleaned, district-harmonized, and feature-engineered datasets.
- **03_Modeling/ & 05_Machine_Learning/**: Model training, validation, and feature engineering scripts.
- **04_EDA/**: Exploratory data analysis outputs and summaries.
- **04_Deployment/**: FastAPI backend (api.py), serialized .joblib models, prediction services, and dashboard analytics endpoints.
- **frontend/**: React + Vite web application for interactive yield forecasting, weather/soil insights, and user authentication.

## Quick Start

### 1. Backend (FastAPI)
1. Navigate to `04_Deployment` and create a virtual environment: `python -m venv .venv`
2. Activate it: `.venv\Scripts\Activate.ps1`
3. Install dependencies: `pip install -r requirements.txt`
4. Copy `.env.example` to `.env` and add your `GROQ_API_KEY` and `GROQ_MODEL`.
5. Start the API server: `uvicorn api:app --reload` (runs at `http://127.0.0.1:8000`).

### 2. Frontend (React + Vite)
1. Navigate to `frontend` and install packages: `npm install`
2. Copy `.env.example` to `.env.local`.
3. Start the dev server: `npm run dev` (runs at `http://localhost:5173`).

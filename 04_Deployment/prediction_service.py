import sys
from pathlib import Path

import pandas as pd
from pymongo import MongoClient

PROJECT_ROOT = Path(r"C:\MINI_PROJECT_FINAL")
MONGO_URI = "mongodb://localhost:27017/"
DB_NAME = "crop_analysis"
COLLECTION_NAME = "crop_records"

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from predict_crop_yield import predict_yield


def get_historical_data():
    """Load historical crop records from MongoDB."""
    client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)

    try:
        client.admin.command("ping")
        records = list(
            client[DB_NAME][COLLECTION_NAME].find(
                {},
                {"_id": 0}
            )
        )
    finally:
        client.close()

    if not records:
        raise RuntimeError("No historical crop records found in MongoDB.")

    df = pd.DataFrame(records)

    required = [
        "District_Name",
        "Crop_Year",
        "Season",
        "Crop",
        "Yield_kg_ha",
    ]

    missing = [column for column in required if column not in df.columns]
    if missing:
        raise ValueError(f"MongoDB records are missing columns: {missing}")

    df["District_Name"] = df["District_Name"].astype(str).str.strip()
    df["Season"] = df["Season"].astype(str).str.strip()
    df["Crop"] = df["Crop"].astype(str).str.strip()
    df["Crop_Year"] = pd.to_numeric(df["Crop_Year"], errors="coerce")
    df["Yield_kg_ha"] = pd.to_numeric(df["Yield_kg_ha"], errors="coerce")

    return df


def get_prediction(district, crop, season, year):
    """Return a Weighted3Y prediction using MongoDB historical records."""
    df = get_historical_data()

    return predict_yield(
        df=df,
        district=district,
        crop=crop,
        season=season,
        year=year,
    )

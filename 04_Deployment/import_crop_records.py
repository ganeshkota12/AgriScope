import pandas as pd
from pymongo import MongoClient

CSV_PATH = r"C:\MINI_PROJECT_FINAL\02_Integrated_Data\Seasonal_Yield_Feature_Engineered_v2.csv"
MONGO_URI = "mongodb://localhost:27017/"
DB_NAME = "crop_analysis"

df = pd.read_csv(CSV_PATH)
df = df.astype(object).where(pd.notna(df), None)
records = df.to_dict(orient="records")

client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
client.admin.command("ping")
collection = client[DB_NAME]["crop_records"]

if collection.count_documents({}) != 0:
    raise RuntimeError("Import stopped: crop_records is not empty.")

result = collection.insert_many(records, ordered=True)

print("Import successful.")
print("CSV rows:", len(df))
print("MongoDB records inserted:", len(result.inserted_ids))
print("MongoDB total records:", collection.count_documents({}))
client.close()

import os
import glob
import pandas as pd

root = r"C:\MINI_PROJECT_FINAL"
source_dir = os.path.join(root, "01_Data_Collection", "satellite_ndvi")
output_dir = os.path.join(root, "02_Integrated_Data")
output_file = os.path.join(
    output_dir, "Rice_NDVI_AP13_2018_2022_Standardized.csv"
)

district_map = {
    "anantapur": "ANANTAPUR",
    "chittoor": "CHITTOOR",
    "east godavari": "EAST GODAVARI",
    "guntur": "GUNTUR",
    "krishna": "KRISHNA",
    "kurnool": "KURNOOL",
    "prakasam": "PRAKASAM",
    "sri potti sriramulu nellore": "SPSR NELLORE",
    "srikakulam": "SRIKAKULAM",
    "visakhapatnam": "VISAKHAPATANAM",
    "vizianagaram": "VIZIANAGARAM",
    "west godavari": "WEST GODAVARI",
    "y.s.r.": "KADAPA"
}

files = sorted(glob.glob(
    os.path.join(source_dir, "Rice_NDVI_*_AP13.csv")
))

if len(files) != 6:
    raise ValueError(f"Expected 6 NDVI files, found {len(files)}")

frames = []

for file in files:
    df = pd.read_csv(file)

    def get_col(*names):
        for name in names:
            if name in df.columns:
                return df[name]
        return pd.Series([None] * len(df))

    ndvi = pd.to_numeric(
        get_col("rice_ndvi_mean", "mean"), errors="coerce"
    )
    district = get_col("district").astype("string").str.strip()
    code = pd.to_numeric(get_col("censuscode"), errors="coerce")
    season = get_col("Season", "season").astype("string").str.strip()
    year = pd.to_numeric(get_col("Year", "year"), errors="coerce")

    if len(df) != 13 or district.nunique() != 13:
        raise ValueError(f"District count check failed: {os.path.basename(file)}")

    if ndvi.isna().any() or not ndvi.between(-1, 1).all():
        raise ValueError(f"NDVI validation failed: {os.path.basename(file)}")

    canonical = district.str.lower().map(district_map)
    if canonical.isna().any():
        raise ValueError(f"Unmapped district in {os.path.basename(file)}")

    out = pd.DataFrame({
        "State_Name": "ANDHRA PRADESH",
        "District_Name": canonical,
        "Satellite_District_Name": district,
        "censuscode": code,
        "Crop": "Rice",
        "Season": season,
        "Crop_Year": year.astype("Int64"),
        "rice_ndvi_mean": ndvi,
        "ndvi_scale_m": pd.to_numeric(get_col("ndvi_scale_m"), errors="coerce"),
        "rice_map_season": get_col("rice_map_season"),
        "start_date": get_col("start_date"),
        "end_date": get_col("end_date"),
        "mask_source": get_col("mask_source"),
        "Source_File": os.path.basename(file)
    })
    frames.append(out)

result = pd.concat(frames, ignore_index=True)

if result.duplicated(["censuscode", "Crop_Year", "Season"]).any():
    raise ValueError("Duplicate district-year-season keys found")

os.makedirs(output_dir, exist_ok=True)
result.to_csv(output_file, index=False)

print("SUCCESS: Standardized NDVI dataset created")
print("Output:", output_file)
print("Rows:", len(result))
print("Columns:", len(result.columns))
print("Unique districts:", result["District_Name"].nunique())
print("Years:", sorted(result["Crop_Year"].dropna().unique().tolist()))
print("Seasons:", sorted(result["Season"].dropna().unique().tolist()))
print("Missing NDVI:", int(result["rice_ndvi_mean"].isna().sum()))
print("Original files were not modified.")

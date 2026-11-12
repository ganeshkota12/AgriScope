import json
from pathlib import Path
import numpy as np
import pandas as pd

# --------------------------------------------------
# PATHS
# --------------------------------------------------
PROJECT = Path(r"C:\MINI_PROJECT_FINAL")
INPUT_CSV = PROJECT / "02_Integrated_Data" / "Seasonal_Yield_Feature_Engineered_v2.csv"
CACHE_DIR = Path(r"C:\MINI_PROJECT\crop_project\power_cache")
OUTPUT_CSV = PROJECT / "02_Integrated_Data" / "Seasonal_Yield_Preseason_Weather.csv"

# --------------------------------------------------
# PRE-SEASON WINDOWS (provisional assumptions)
# End dates are inclusive.
# --------------------------------------------------
# RESEARCH ASSUMPTIONS — pre-season weather windows.
# Forecast cutoffs: Rice Kharif = Jun 1; Rice Rabi = Dec 1;
# Dry chillies Kharif = Aug 1; Dry chillies Rabi = Nov 1.
# Only weather observed before the relevant cutoff may be used.
# These cutoffs are experimental assumptions, not official forecasts.
WINDOWS = {
    ("Rice", "Kharif"): ("01-01", "05-31"),
    ("Rice", "Rabi"): ("07-01", "11-30"),
    ("Dry chillies", "Kharif"): ("01-01", "07-31"),
    ("Dry chillies", "Rabi"): ("05-01", "10-31"),
}

# Weather cache variable names
VARIABLES = {
    "PRECTOTCORR": "rainfall",
    "T2M": "temp_mean",
    "T2M_MIN": "temp_min",
    "T2M_MAX": "temp_max",
    "RH2M": "humidity",
    "ALLSKY_SFC_SW_DWN": "solar",
    "EVPTRNS": "evapotranspiration",
}

# Match each district to the coordinates used by the cache.
DISTRICT_COORDS = {
    "ANANTAPUR": (14.4570, 77.5094),
    "CHITTOOR": (13.3074, 78.9823),
    "EAST GODAVARI": (17.1621, 82.0566),
    "GUNTUR": (16.2868, 80.1836),
    "KRISHNA": (16.4283, 81.0626),
    "KURNOOL": (15.5549, 77.9044),
    "PRAKASAM": (15.6355, 79.5113),
    "SPSR NELLORE": (14.2926, 79.7825),
    "SRIKAKULAM": (18.6233, 83.9716),
    "VISAKHAPATNAM": (17.8969, 82.5657),
    "VISAKHAPATANAM": (17.8969, 82.5657),
    "VIZIANAGARAM": (18.4946, 83.3119),
    "WEST GODAVARI": (16.9020, 81.3520),
    "YSR KADAPA": (14.4825, 78.6567),
    "KADAPA": (14.4825, 78.6567),
}


def load_daily_cache(district, year):
    """Load daily observations for one district and calendar year."""
    coords = DISTRICT_COORDS.get(str(district).strip().upper())
    if coords is None:
        raise ValueError(f"No cache coordinates for district: {district}")

    lat, lon = coords
    path = CACHE_DIR / f"{lat:.4f}_{lon:.4f}_{year}.json"

    if not path.exists():
        raise FileNotFoundError(f"Missing daily weather cache: {path}")

    with path.open("r", encoding="utf-8") as file:
        raw = json.load(file)

    data = {}
    for variable in VARIABLES:
        if variable not in raw:
            raise ValueError(f"{variable} missing from {path}")

        series = pd.Series(raw[variable], dtype="float64")
        series.index = pd.to_datetime(series.index, format="%Y%m%d")
        series = series.sort_index()
        series = series.replace([-999, -999.0], np.nan)
        data[variable] = series

    return pd.DataFrame(data).sort_index()


def get_weather_features(district, crop, season, year):
    """Summarize weather observed strictly before the crop-season cutoff."""
    key = (str(crop).strip(), str(season).strip())
    if key not in WINDOWS:
        raise ValueError(f"Unknown crop-season combination: {key}")

    start_md, end_md = WINDOWS[key]
    start_date = pd.Timestamp(f"{int(year)}-{start_md}")
    end_date = pd.Timestamp(f"{int(year)}-{end_md}")

    cutoff_month = {
        ("Rice", "Kharif"): 6,
        ("Rice", "Rabi"): 12,
        ("Dry chillies", "Kharif"): 8,
        ("Dry chillies", "Rabi"): 11,
    }[(str(crop).strip(), str(season).strip())]
    cutoff_date = pd.Timestamp(year=int(year), month=cutoff_month, day=1)
    if end_date >= cutoff_date:
        raise ValueError(
            f"Pre-season window ends on {end_date.date()}, "
            f"which is not before cutoff {cutoff_date.date()} "
            f"for {crop} {season}, {district}, {year}."
        )

    daily = load_daily_cache(district, int(year))
    daily = daily.loc[(daily.index >= start_date) & (daily.index <= end_date)]

    if daily.empty:
        raise ValueError(f"No daily observations for {district}, {year}, {key}")

    rainfall = daily["PRECTOTCORR"]
    temp = daily["T2M"]
    tmin = daily["T2M_MIN"]
    tmax = daily["T2M_MAX"]
    humidity = daily["RH2M"]
    solar = daily["ALLSKY_SFC_SW_DWN"]
    evap = daily["EVPTRNS"]

    features = {
        "Preseason_Days_Available": int(len(daily)),
        "Preseason_Rainfall_Total_mm": rainfall.sum(min_count=1),
        "Preseason_Rainy_Days_1mm": int((rainfall >= 1).sum()),
        "Preseason_Rainfall_Max_Daily_mm": rainfall.max(),
        "Preseason_Mean_Temperature_C": temp.mean(),
        "Preseason_Mean_Min_Temperature_C": tmin.mean(),
        "Preseason_Mean_Max_Temperature_C": tmax.mean(),
        "Preseason_Mean_Temperature_Range_C": (tmax - tmin).mean(),
        "Preseason_Mean_Relative_Humidity_pct": humidity.mean(),
        # NASA POWER solar values are typically kWh/m²/day.
        # Convert the daily mean to MJ/m²/day.
        "Preseason_Mean_Solar_Radiation_MJ_m2_day": solar.mean() * 3.6,
        "Preseason_Mean_Evapotranspiration_Source_Units": evap.mean(),
    }

    return features


def main():
    df = pd.read_csv(INPUT_CSV)
    required = ["District_Name", "Crop_Year", "Season", "Crop", "Yield_kg_ha"]
    missing = [column for column in required if column not in df.columns]
    if missing:
        raise ValueError(f"Required columns missing: {missing}")

    results = []
    cache = {}

    for index, row in df.iterrows():
        district = str(row["District_Name"]).strip().upper()
        crop = str(row["Crop"]).strip()
        season = str(row["Season"]).strip()
        year = int(row["Crop_Year"])
        cache_key = (district, crop, season, year)

        if cache_key not in cache:
            cache[cache_key] = get_weather_features(district, crop, season, year)

        results.append(cache[cache_key])

        if (index + 1) % 100 == 0:
            print(f"Processed {index + 1}/{len(df)} rows")

    weather_df = pd.DataFrame(results, index=df.index)
    output = pd.concat([df, weather_df], axis=1)

    # Do not overwrite the original dataset.
    output.to_csv(OUTPUT_CSV, index=False)

    print("\nFeature generation complete.")
    print(f"Rows: {len(output)}")
    print(f"New weather features: {len(weather_df.columns)}")
    print(f"Missing values in new features: {weather_df.isna().sum().sum()}")
    print(f"Output: {OUTPUT_CSV}")
    print("\nFeatures created:")
    print("\n".join(weather_df.columns))


if __name__ == "__main__":
    main()

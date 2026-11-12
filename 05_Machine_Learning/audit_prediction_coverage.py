from pathlib import Path
import json
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DATA_FILE = ROOT / "02_Integrated_Data" / "Seasonal_Yield_Preseason_Weather.csv"
MODEL_DIR = ROOT / "04_Deployment" / "preseason_models"
OUTPUT_DIR = ROOT / "02_Integrated_Data"

YEARS = list(range(2011, 2015))
CROPS = ["Rice", "Dry chillies"]
SEASONS = ["Kharif", "Rabi"]


def norm(series):
    return series.astype(str).str.strip().str.casefold()


def main():
    if not DATA_FILE.exists():
        raise FileNotFoundError(f"Dataset not found: {DATA_FILE}")

    df = pd.read_csv(DATA_FILE)
    required = ["District_Name", "Crop", "Season", "Crop_Year", "Yield_kg_ha"]
    missing = [col for col in required if col not in df.columns]
    if missing:
        raise ValueError(f"Missing required dataset columns: {missing}")

    df["Crop_Year"] = pd.to_numeric(df["Crop_Year"], errors="coerce")

    # Check saved model metadata and feature compatibility.
    model_features = {}
    for crop, filename in [
        ("Rice", "Rice_Preseason_Metadata.json"),
        ("Dry chillies", "Dry_Chillies_Preseason_Metadata.json"),
    ]:
        path = MODEL_DIR / filename
        if not path.exists():
            raise FileNotFoundError(f"Model metadata not found: {path}")

        with open(path, "r", encoding="utf-8") as file:
            metadata = json.load(file)

        features = metadata.get("feature_columns")
        if not features:
            raise ValueError(
                f"No feature_columns in {filename}. "
                f"Available keys: {list(metadata.keys())}"
            )
        model_features[crop] = features

    districts = sorted(df["District_Name"].dropna().astype(str).str.strip().unique())
    if len(districts) != 13:
        print(f"WARNING: Dataset contains {len(districts)} districts, not 13.")

    records = []
    missing_feature_rows = []
    duplicate_rows = []

    district_norm = norm(df["District_Name"])
    crop_norm = norm(df["Crop"])
    season_norm = norm(df["Season"])

    for district in districts:
        for crop in CROPS:
            for season in SEASONS:
                for year in YEARS:
                    mask = (
                        (district_norm == district.casefold())
                        & (crop_norm == crop.casefold())
                        & (season_norm == season.casefold())
                        & (df["Crop_Year"] == year)
                    )
                    matches = df.loc[mask]

                    record = {
                        "District_Name": district,
                        "Crop": crop,
                        "Season": season,
                        "Crop_Year": year,
                        "Matching_Rows": len(matches),
                        "Record_Status": (
                            "MISSING_RECORD"
                            if matches.empty
                            else (
                                "DUPLICATE_RECORD" if len(matches) > 1 else "ONE_RECORD"
                            )
                        ),
                    }

                    if len(matches) == 1:
                        row = matches.iloc[0]
                        features = model_features[crop]
                        absent_columns = [
                            col for col in features if col not in df.columns
                        ]
                        null_features = [
                            col
                            for col in features
                            if col in df.columns and pd.isna(row[col])
                        ]

                        record["Missing_Model_Columns"] = len(absent_columns)
                        record["Null_Model_Features"] = len(null_features)
                        record["Missing_Column_Names"] = ";".join(absent_columns)
                        record["Null_Feature_Names"] = ";".join(null_features)
                        record["Yield_Missing"] = pd.isna(row["Yield_kg_ha"])

                        if absent_columns or null_features:
                            missing_feature_rows.append(
                                {
                                    **record,
                                }
                            )

                    elif len(matches) > 1:
                        duplicate_rows.append(record)

                    records.append(record)

    coverage = pd.DataFrame(records)
    feature_report = pd.DataFrame(missing_feature_rows)
    duplicates = pd.DataFrame(duplicate_rows)

    coverage_path = OUTPUT_DIR / "Prediction_Coverage_Audit.csv"
    feature_path = OUTPUT_DIR / "Prediction_Feature_Gaps.csv"
    duplicate_path = OUTPUT_DIR / "Prediction_Duplicate_Records.csv"

    coverage.to_csv(coverage_path, index=False)
    feature_report.to_csv(feature_path, index=False)
    duplicates.to_csv(duplicate_path, index=False)

    print("\n=== PREDICTION COVERAGE AUDIT ===")
    print("Expected combinations:", len(coverage))
    print("\nRecord status:")
    print(coverage["Record_Status"].value_counts().to_string())
    print("\nMissing records by crop and season:")
    missing_records = coverage[coverage["Record_Status"] == "MISSING_RECORD"]
    if missing_records.empty:
        print("None")
    else:
        print(missing_records.groupby(["Crop", "Season"]).size().to_string())

    print("\nUnique records with missing model inputs:", len(feature_report))
    print("Duplicate combinations:", len(duplicates))

    if not feature_report.empty:
        print("\nExamples of feature gaps:")
        print(
            feature_report[
                [
                    "District_Name",
                    "Crop",
                    "Season",
                    "Crop_Year",
                    "Null_Model_Features",
                    "Null_Feature_Names",
                ]
            ]
            .head(15)
            .to_string(index=False)
        )

    print("\nReports saved:")
    print(coverage_path)
    print(feature_path)
    print(duplicate_path)
    print("\nNo source data was modified.")
    print("This audit does not generate predictions or impute values.")


if __name__ == "__main__":
    main()

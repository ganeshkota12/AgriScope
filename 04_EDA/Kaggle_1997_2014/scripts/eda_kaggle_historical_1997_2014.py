from pathlib import Path
import pandas as pd
import matplotlib.pyplot as plt

# ==========================================
# AGRISCOPE - HISTORICAL DATA EDA
# Dataset: Kaggle Integrated Master
# Period: 1997-2014
# Crops: Rice and Dry Chillies
# ==========================================

ROOT = Path(r"C:\MINI_PROJECT_FINAL")

INPUT_FILE = ROOT / "03_Integrated_Data" / "FINAL_KAGGLE_INTEGRATED_MASTER.csv"

OUTPUT_DIR = ROOT / "04_EDA" / "Kaggle_1997_2014"

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

print("\nLoading dataset...")

df = pd.read_csv(INPUT_FILE)

print("Original shape:", df.shape)

# ------------------------------------------
# 1. REQUIRED COLUMNS
# ------------------------------------------

required_columns = [
    "Crop",
    "District_Name",
    "Crop_Year",
    "Season",
    "Yield_kg_ha",
    "Rainfall_mm",
    "Mean_Temperature_C",
    "Min_Temperature_C",
    "Max_Temperature_C",
    "Relative_Humidity_pct",
    "Solar_Radiation_MJ_m2_day",
    "ET0_mm"
]

missing_columns = [
    col for col in required_columns
    if col not in df.columns
]

if missing_columns:
    raise ValueError(f"Missing columns: {missing_columns}")

# ------------------------------------------
# 2. DATA CLEANING
# ------------------------------------------

df["Crop"] = df["Crop"].astype(str).str.strip()
df["District_Name"] = df["District_Name"].astype(str).str.strip()
df["Season"] = df["Season"].astype(str).str.strip()

df["Crop_Year"] = pd.to_numeric(
    df["Crop_Year"], errors="coerce"
)

df["Yield_kg_ha"] = pd.to_numeric(
    df["Yield_kg_ha"], errors="coerce"
)

df = df[
    df["Crop"].str.lower().isin(["rice", "dry chillies"])
    & df["Crop_Year"].between(1997, 2014)
].copy()

if df.empty:
    raise ValueError("No records found after filtering.")

print("\nFiltered dataset shape:", df.shape)

# ------------------------------------------
# 3. BASIC INFORMATION
# ------------------------------------------

print("\n========== DATASET INFORMATION ==========")

print("\nRows:", len(df))

print("Columns:", len(df.columns))

print("Districts:", df["District_Name"].nunique())

print("Crops:", df["Crop"].unique())

print(
    "Year range:",
    int(df["Crop_Year"].min()),
    "-",
    int(df["Crop_Year"].max())
)

print("\nCrop distribution:")
print(df["Crop"].value_counts())

print("\nSeason distribution:")
print(df["Season"].value_counts())

print("\nDistrict distribution:")
print(df["District_Name"].value_counts())

# ------------------------------------------
# 4. DUPLICATE CHECK
# ------------------------------------------

key_columns = [
    "Crop",
    "District_Name",
    "Crop_Year",
    "Season"
]

duplicates = df.duplicated(
    subset=key_columns
).sum()

print("\nDuplicate records:", duplicates)

# ------------------------------------------
# 5. MISSING VALUE ANALYSIS
# ------------------------------------------

missing = df.isnull().sum()

missing = missing[missing > 0].sort_values(
    ascending=False
)

print("\n========== MISSING VALUES ==========")

if len(missing) == 0:
    print("No missing values.")
else:
    print(missing)

missing.to_csv(
    OUTPUT_DIR / "Missing_Values.csv"
)

# ------------------------------------------
# 6. CROP-WISE YIELD ANALYSIS
# ------------------------------------------

observed = df.dropna(
    subset=["Yield_kg_ha"]
).copy()

crop_summary = observed.groupby("Crop")[
    "Yield_kg_ha"
].agg(
    Observations="count",
    Mean="mean",
    Median="median",
    Standard_Deviation="std",
    Minimum="min",
    Maximum="max"
).round(2)

print("\n========== CROP-WISE YIELD ==========")

print(crop_summary)

crop_summary.to_csv(
    OUTPUT_DIR / "Crop_Yield_Summary.csv"
)

# ------------------------------------------
# 7. SEASON-WISE YIELD ANALYSIS
# ------------------------------------------

seasonal = observed[
    observed["Season"].isin(["Kharif", "Rabi"])
].copy()

season_summary = seasonal.groupby(
    ["Crop", "Season"]
)["Yield_kg_ha"].agg(
    Observations="count",
    Mean="mean",
    Median="median",
    Standard_Deviation="std"
).round(2)

print("\n========== SEASON-WISE YIELD ==========")

print(season_summary)

season_summary.to_csv(
    OUTPUT_DIR / "Crop_Season_Summary.csv"
)

# ------------------------------------------
# 8. YEAR-WISE YIELD ANALYSIS
# ------------------------------------------

yearly = observed.groupby(
    ["Crop", "Crop_Year"]
).agg(
    Mean_Yield=("Yield_kg_ha", "mean"),
    Observations=("Yield_kg_ha", "count")
).reset_index()

yearly.to_csv(
    OUTPUT_DIR / "Yearly_Yield_Summary.csv",
    index=False
)

# ------------------------------------------
# 9. WEATHER CORRELATION ANALYSIS
# ------------------------------------------

weather_columns = [
    "Rainfall_mm",
    "Mean_Temperature_C",
    "Min_Temperature_C",
    "Max_Temperature_C",
    "Relative_Humidity_pct",
    "Solar_Radiation_MJ_m2_day",
    "ET0_mm"
]

correlation_results = []

for crop, group in observed.groupby("Crop"):

    for feature in weather_columns:

        valid = group[
            [feature, "Yield_kg_ha"]
        ].dropna()

        correlation = (
            valid[feature].corr(valid["Yield_kg_ha"])
            if len(valid) >= 3
            else None
        )

        correlation_results.append({
            "Crop": crop,
            "Weather_Feature": feature,
            "Observations": len(valid),
            "Correlation": correlation
        })

correlation_df = pd.DataFrame(
    correlation_results
)

print("\n========== WEATHER CORRELATIONS ==========")

print(correlation_df.to_string(index=False))

correlation_df.to_csv(
    OUTPUT_DIR / "Weather_Yield_Correlations.csv",
    index=False
)

# ------------------------------------------
# 10. SOIL FEATURE COVERAGE
# ------------------------------------------

soil_prefixes = (
    "Soil_pH_",
    "Organic_Carbon_",
    "Total_Nitrogen_",
    "Clay_pct_",
    "Sand_pct_",
    "Silt_pct_",
    "Bulk_Density_",
    "CEC_",
    "Coarse_Fragments_"
)

soil_columns = [
    col for col in observed.columns
    if col.startswith(soil_prefixes)
]

soil_coverage = pd.DataFrame({
    "Feature": soil_columns,
    "Available_Values": [
        observed[col].notna().sum()
        for col in soil_columns
    ],
    "Missing_Values": [
        observed[col].isna().sum()
        for col in soil_columns
    ]
})

soil_coverage.to_csv(
    OUTPUT_DIR / "Soil_Feature_Coverage.csv",
    index=False
)

# ------------------------------------------
# 11. YIELD DISTRIBUTION
# ------------------------------------------

for crop, group in observed.groupby("Crop"):

    plt.figure(figsize=(8, 5))

    plt.hist(
        group["Yield_kg_ha"],
        bins=20,
        edgecolor="black"
    )

    plt.title(f"{crop} - Yield Distribution")

    plt.xlabel("Yield_kg_ha")

    plt.ylabel("Frequency")

    plt.tight_layout()

    filename = crop.replace(" ", "_")

    plt.savefig(
        OUTPUT_DIR / f"{filename}_Yield_Distribution.png",
        dpi=250
    )

    plt.close()

# ------------------------------------------
# 12. SEASONAL COMPARISON
# ------------------------------------------

for crop, group in seasonal.groupby("Crop"):

    kharif = group.loc[
        group["Season"] == "Kharif",
        "Yield_kg_ha"
    ].dropna()

    rabi = group.loc[
        group["Season"] == "Rabi",
        "Yield_kg_ha"
    ].dropna()

    plt.figure(figsize=(8, 5))

    plt.boxplot(
        [kharif, rabi],
        tick_labels=["Kharif", "Rabi"]
    )

    plt.title(f"{crop} - Seasonal Yield Comparison")

    plt.xlabel("Season")

    plt.ylabel("Yield_kg_ha")

    plt.tight_layout()

    filename = crop.replace(" ", "_")

    plt.savefig(
        OUTPUT_DIR / f"{filename}_Seasonal_Comparison.png",
        dpi=250
    )

    plt.close()

# ------------------------------------------
# 13. YEARLY YIELD TREND
# ------------------------------------------

for crop, group in yearly.groupby("Crop"):

    group = group.sort_values("Crop_Year")

    plt.figure(figsize=(11, 5))

    plt.plot(
        group["Crop_Year"],
        group["Mean_Yield"],
        marker="o"
    )

    plt.title(f"{crop} - Yearly Yield Trend")

    plt.xlabel("Year")

    plt.ylabel("Mean Yield_kg_ha")

    plt.xticks(
        group["Crop_Year"],
        rotation=60
    )

    plt.tight_layout()

    filename = crop.replace(" ", "_")

    plt.savefig(
        OUTPUT_DIR / f"{filename}_Yearly_Trend.png",
        dpi=250
    )

    plt.close()

# ------------------------------------------
# 14. WEATHER VS YIELD SCATTER PLOTS
# ------------------------------------------

for crop, group in observed.groupby("Crop"):

    for feature in weather_columns:

        valid = group[
            [feature, "Yield_kg_ha"]
        ].dropna()

        if len(valid) < 3:
            continue

        plt.figure(figsize=(7, 5))

        plt.scatter(
            valid[feature],
            valid["Yield_kg_ha"],
            alpha=0.65
        )

        plt.title(f"{crop} - Yield vs {feature}")

        plt.xlabel(feature)

        plt.ylabel("Yield_kg_ha")

        plt.tight_layout()

        filename = (
            crop.replace(" ", "_")
            + "_Yield_vs_"
            + feature.replace("/", "_")
        )

        plt.savefig(
            OUTPUT_DIR / f"{filename}.png",
            dpi=220
        )

        plt.close()

# ------------------------------------------
# 15. SAVE EDA SUMMARY
# ------------------------------------------

summary = []

summary.append(
    "AGRISCOPE - KAGGLE HISTORICAL EDA"
)

summary.append("=" * 50)

summary.append(f"Total records: {len(df)}")

summary.append(
    f"Districts: {df['District_Name'].nunique()}"
)

summary.append(
    f"Year range: {int(df['Crop_Year'].min())}-"
    f"{int(df['Crop_Year'].max())}"
)

summary.append(
    f"Duplicate records: {duplicates}"
)

summary.append("\nCrop distribution:")

summary.append(
    df["Crop"].value_counts().to_string()
)

summary.append("\nSeason distribution:")

summary.append(
    df["Season"].value_counts().to_string()
)

summary.append("\nCrop-wise yield summary:")

summary.append(
    crop_summary.to_string()
)

summary.append("\nSeason-wise yield summary:")

summary.append(
    season_summary.to_string()
)

summary.append("\nInterpretation notes:")

summary.append(
    "- Whole Year records are retained in overall analysis."
)

summary.append(
    "- Only Kharif and Rabi are used for seasonal comparison."
)

summary.append(
    "- Correlation indicates association, not causation."
)

summary.append(
    "- Soil features represent modelled district-level estimates."
)

summary.append(
    "- Verify the original yield source and units before "
    "presenting Yield_kg_ha as a confirmed unit."
)

summary.append(
    "- Missing values are not automatically replaced with zero."
)

(OUTPUT_DIR / "EDA_Summary.txt").write_text(
    "\n".join(summary),
    encoding="utf-8"
)

# ------------------------------------------
# COMPLETION
# ------------------------------------------

print("\n==========================================")
print("EDA COMPLETED SUCCESSFULLY")
print("==========================================")

print("\nOutput folder:")
print(OUTPUT_DIR)

print("\nGenerated files:")
for file in sorted(OUTPUT_DIR.iterdir()):
    print(file.name)


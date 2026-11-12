#!/usr/bin/env python3
"""
Stage 8 — Experiment A: Crop-specific Random Forest models
with group-mean encoding for District × Crop × Season.

What is new vs Stage 7:
  1. Separate models for Rice and Dry chillies (no pooling).
  2. A training-only group-mean feature encodes baseline district-crop-season productivity.
  3. Lag-1 and rolling-mean baselines are reported alongside every model result.
  4. Residuals are saved per crop for post-hoc analysis.
  5. Reads Seasonal_Yield_Feature_Engineered_v2.csv (stable baseline file).

Nothing is overwritten. Results go to Stage8_Crop_Specific_Results.csv and
Stage8_Crop_Specific_Residuals.csv.
"""

from pathlib import Path
import warnings
import numpy as np
import pandas as pd

from sklearn.compose import ColumnTransformer
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

warnings.filterwarnings("ignore")

# ── Paths ──────────────────────────────────────────────────────────────────
BASE         = Path(r"C:\MINI_PROJECT_FINAL\02_Integrated_Data")
INPUT_FILE   = BASE / "Seasonal_Yield_Feature_Engineered_v2.csv"
RESULTS_FILE = BASE / "Stage8_Crop_Specific_Results.csv"
RESID_FILE   = BASE / "Stage8_Crop_Specific_Residuals.csv"

TARGET  = "Yield_kg_ha"
CAT     = ["District_Name", "Season"]          # Crop dropped — single-crop models
LAGS    = ["Yield_Lag_1Y", "Yield_Lag_2Y", "Yield_Rolling_Mean_3Y"]

TRAIN_YEARS = (1997, 2010)
TEST_YEARS  = (2011, 2014)

# ── Load and clean ─────────────────────────────────────────────────────────
df = pd.read_csv(INPUT_FILE)
for col in ["District_Name", "Crop", "Season"]:
    df[col] = df[col].astype(str).str.strip()
df["Crop_Year"] = pd.to_numeric(df["Crop_Year"], errors="raise")
df[TARGET]      = pd.to_numeric(df[TARGET],      errors="raise")
df = df.sort_values(["District_Name", "Crop", "Season", "Crop_Year"]).reset_index(drop=True)

print(f"Full dataset: {df.shape}")
print(f"Crops: {df.Crop.value_counts().to_dict()}")
print(f"Years: {df.Crop_Year.min()}–{df.Crop_Year.max()}")

# ── Build feature lists (exclude target, year, status, area, production) ──
EXCLUDE = {TARGET, "Crop_Year", "Yield_Status", "Crop",
           "Yield_Change_From_Previous_Year",
           "Yield_Percent_Change_From_Previous_Year",
           "State_Name"}
EXCLUDE |= {c for c in df.columns
            if c.lower() in {"area", "production"}
            or c.lower().startswith("area_")
            or c.lower().startswith("production_")}

WEATHER = [c for c in df.columns if c.startswith("Weather_") and c not in LAGS]
SOIL    = [c for c in df.columns if c.startswith("Soil_")]
BASE_NUMERIC = WEATHER + SOIL + LAGS

# Feature sets to compare
FEATURE_SETS = {
    "Lags_Only":    CAT + LAGS,
    "Weather_Lags": CAT + WEATHER + LAGS,
    "Full":         CAT + WEATHER + SOIL + LAGS,
}

all_results  = []
all_residuals = []

for crop in ["Rice", "Dry chillies"]:
    crop_df = df[df["Crop"] == crop].copy()

    train_all = crop_df[crop_df["Crop_Year"].between(*TRAIN_YEARS)].copy()
    test_full = crop_df[crop_df["Crop_Year"].between(*TEST_YEARS)].copy()
    test      = test_full.dropna(subset=LAGS).copy()

    print(f"\n{'='*55}")
    print(f"CROP: {crop}")
    print(f"  Training rows (all, incl. lag-null): {len(train_all)}")
    print(f"  Test rows (lag-complete):             {len(test)}")
    print(f"  Test years: {sorted(test.Crop_Year.unique())}")

    if len(train_all) < 20 or len(test) < 5:
        print("  SKIPPED — insufficient data.")
        continue

    # ── Lag-1 baseline ─────────────────────────────────────────────────
    lag1_r2  = r2_score(test[TARGET], test["Yield_Lag_1Y"])
    lag1_mae = mean_absolute_error(test[TARGET], test["Yield_Lag_1Y"])
    roll_r2  = r2_score(test[TARGET], test["Yield_Rolling_Mean_3Y"])
    roll_mae = mean_absolute_error(test[TARGET], test["Yield_Rolling_Mean_3Y"])
    print(f"  Lag-1 baseline: R²={lag1_r2:.4f}, MAE={lag1_mae:.0f}")
    print(f"  Rolling-3Y baseline: R²={roll_r2:.4f}, MAE={roll_mae:.0f}")

    for base_result in [
        {"Experiment": "Stage8_CropSpecific", "Crop": crop,
         "Feature_Set": "Lag1_Persistence",
         "Algorithm": "Lag1_Baseline",
         "n_features": 1,
         "n_train": len(train_all.dropna(subset=["Yield_Lag_1Y"])),
         "n_test": len(test),
         "Test_Years": f"{TEST_YEARS[0]}-{TEST_YEARS[1]}",
         "MAE": lag1_mae, "RMSE": np.sqrt(mean_squared_error(test[TARGET], test["Yield_Lag_1Y"])),
         "R2": lag1_r2, "Lag1_R2": lag1_r2},
        {"Experiment": "Stage8_CropSpecific", "Crop": crop,
         "Feature_Set": "Rolling3Y_Persistence",
         "Algorithm": "Rolling3Y_Baseline",
         "n_features": 1,
         "n_train": len(train_all.dropna(subset=["Yield_Rolling_Mean_3Y"])),
         "n_test": len(test),
         "Test_Years": f"{TEST_YEARS[0]}-{TEST_YEARS[1]}",
         "MAE": roll_mae, "RMSE": np.sqrt(mean_squared_error(test[TARGET], test["Yield_Rolling_Mean_3Y"])),
         "R2": roll_r2, "Lag1_R2": lag1_r2},
    ]:
        all_results.append(base_result)

    # ── Group-mean encoding (training data only) ───────────────────────
    # Encode District × Season baseline productivity from the training set.
    # Groups unseen in training are imputed with the overall training mean.
    group_key = ["District_Name", "Season"]
    group_mean = (train_all
                  .groupby(group_key)[TARGET]
                  .mean()
                  .rename("DistrictSeason_Mean_Yield"))

    def add_group_mean(data, gm_series, overall_mean):
        merged = data.merge(gm_series.reset_index(),
                            on=group_key, how="left")
        merged["DistrictSeason_Mean_Yield"] = merged["DistrictSeason_Mean_Yield"].fillna(overall_mean)
        return merged

    overall_mean = train_all[TARGET].mean()
    train_gm = add_group_mean(train_all, group_mean, overall_mean)
    test_gm  = add_group_mean(test,      group_mean, overall_mean)

    GM_COL = "DistrictSeason_Mean_Yield"

    # Feature sets with group-mean variant
    FEAT_SETS_WITH_GM = {}
    for fs_name, fs_cols in FEATURE_SETS.items():
        FEAT_SETS_WITH_GM[fs_name]         = fs_cols
        FEAT_SETS_WITH_GM[fs_name + "_GM"] = fs_cols + [GM_COL]

    for fs_name, feature_cols in FEAT_SETS_WITH_GM.items():
        # Determine which DataFrame to use
        using_gm = GM_COL in feature_cols
        tr_use = train_gm if using_gm else train_all
        te_use = test_gm  if using_gm else test

        # Keep only columns that exist
        feature_cols = [c for c in feature_cols if c in tr_use.columns and c not in EXCLUDE]

        cat_in_feat = [c for c in CAT if c in feature_cols]
        num_in_feat = [c for c in feature_cols if c not in cat_in_feat]

        if not feature_cols:
            continue

        pre = ColumnTransformer([
            ("num", Pipeline([
                ("imp", SimpleImputer(strategy="median")),
                ("sc",  StandardScaler()),
            ]), num_in_feat),
            ("cat", Pipeline([
                ("imp", SimpleImputer(strategy="most_frequent")),
                ("ohe", OneHotEncoder(handle_unknown="ignore")),
            ]), cat_in_feat),
        ])

        pipe = Pipeline([
            ("preprocessor", pre),
            ("model", RandomForestRegressor(
                n_estimators=300,
                max_features=0.7,
                min_samples_leaf=1,
                random_state=42,
                n_jobs=-1,
            )),
        ])

        pipe.fit(tr_use[feature_cols], tr_use[TARGET])
        pred = pipe.predict(te_use[feature_cols])

        mae  = mean_absolute_error(te_use[TARGET], pred)
        rmse = np.sqrt(mean_squared_error(te_use[TARGET], pred))
        r2   = r2_score(te_use[TARGET], pred)

        print(f"  {fs_name:<26} R²={r2:.4f}  MAE={mae:.0f}  RMSE={rmse:.0f}  "
              f"(n_feat={len(feature_cols)})")

        all_results.append({
            "Experiment":  "Stage8_CropSpecific",
            "Crop":        crop,
            "Feature_Set": fs_name,
            "Algorithm":   "RandomForest_300t_0.7feat",
            "n_features":  len(feature_cols),
            "n_train":     len(tr_use),
            "n_test":      len(te_use),
            "Test_Years":  f"{TEST_YEARS[0]}-{TEST_YEARS[1]}",
            "MAE":         mae,
            "RMSE":        rmse,
            "R2":          r2,
            "Lag1_R2":     lag1_r2,
        })

        # Save residuals for the Full_GM model
        if fs_name == "Full_GM":
            for i, (idx, row) in enumerate(te_use.iterrows()):
                all_residuals.append({
                    "Crop":         crop,
                    "District_Name":row["District_Name"],
                    "Season":       row["Season"],
                    "Crop_Year":    row["Crop_Year"],
                    "Actual":       te_use[TARGET].iloc[i],
                    "Predicted":    pred[i],
                    "Residual":     te_use[TARGET].iloc[i] - pred[i],
                    "AbsError":     abs(te_use[TARGET].iloc[i] - pred[i]),
                    "Lag1_Pred":    row["Yield_Lag_1Y"],
                    "Lag1_Residual":te_use[TARGET].iloc[i] - row["Yield_Lag_1Y"],
                })

# ── Save results ───────────────────────────────────────────────────────────
results_df  = pd.DataFrame(all_results).sort_values(["Crop", "R2"], ascending=[True, False])
residuals_df = pd.DataFrame(all_residuals)

results_df.to_csv(RESULTS_FILE, index=False)
residuals_df.to_csv(RESID_FILE, index=False)

print(f"\n{'='*55}")
print("FINAL RESULTS SUMMARY")
print(results_df.to_string(index=False))
print(f"\nSaved: {RESULTS_FILE}")
print(f"Saved: {RESID_FILE}")

# ── Quick residual summary ─────────────────────────────────────────────────
if not residuals_df.empty:
    print("\nResidual summary by crop:")
    print(residuals_df.groupby("Crop")[["AbsError","Residual"]].describe().round(1))
    print("\nTop 10 largest errors:")
    print(residuals_df.nlargest(10, "AbsError")[
        ["Crop","District_Name","Season","Crop_Year","Actual","Predicted","AbsError"]
    ].to_string(index=False))
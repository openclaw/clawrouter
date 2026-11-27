#!/usr/bin/env bash
set -euo pipefail

# Upgrade/rollback tests run these exact historical trees and fail when absent.
# Fetch without --depth so an existing full checkout keeps its ancestry intact.
baselines=(
  080831563e0adfcdc1b79cad14613249694d60c9
  6fceb88d4d165ba66281c931b74c3047772a2ef5
  df8c3800fbb413fbe7db6833387a1e885d1379cb
  fcdf6900c94ca71fa29411c3b239da8029c98321
  ee02a155e0c3dbec3769ec5beb52fd792745aefc
  434a526a37fff4d91e04cc1caa5cd6aa2eff2d82
)

for baseline in "${baselines[@]}"; do
  if ! git cat-file -e "$baseline^{commit}" 2>/dev/null; then
    git -c maintenance.auto=false -c gc.auto=0 fetch --no-tags origin "$baseline"
  fi
  git cat-file -e "$baseline^{commit}"
done

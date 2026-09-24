#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: apply.sh --url <minivault-root-url> --manifest <path> [--workspace <name>] [--salt <salt>]" >&2
  exit 2
}

url=""
manifest=""
workspace="minivault"
salt=""

while (($#)); do
  case "$1" in
    --url)
      (($# >= 2)) || usage
      url="$2"
      shift 2
      ;;
    --manifest)
      (($# >= 2)) || usage
      manifest="$2"
      shift 2
      ;;
    --workspace)
      (($# >= 2)) || usage
      workspace="$2"
      shift 2
      ;;
    --salt)
      (($# >= 2)) || usage
      salt="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

[[ -n "$url" && -n "$manifest" ]] || usage
[[ "$workspace" =~ ^[a-z0-9]{1,20}$ ]] || {
  echo "Invalid workspace '$workspace': use 1-20 lowercase letters or digits." >&2
  exit 2
}
[[ -f "$manifest" ]] || {
  echo "Manifest not found: $manifest" >&2
  exit 2
}

url="${url%/}"
url="${url%/api}"
export REVAULT_API_URL="$url/api"
export DEVICE_API_URL="$url/device-api"
export REVAULT_DEBUG_AUTH_TOKEN="debug-auth-token"
export REVAULT_ROOT_AUTH_TOKEN="root-auth-token"

for dependency in revault jq curl pnpm; do
  command -v "$dependency" >/dev/null || {
    echo "$dependency is not on PATH." >&2
    exit 127
  }
done

cli_dir="$HOME/ledger/revault/packages/cli"
[[ -f "$cli_dir/src/__scripts__/check-manifests.ts" ]] || {
  echo "revault CLI source not found at $cli_dir." >&2
  exit 2
}

# Parse the complete manifest before any remote mutation.
(cd "$cli_dir" && pnpm exec tsx src/__scripts__/check-manifests.ts "$manifest")

get_debug_collection() {
  curl --fail --show-error --silent \
    -H "x-revault-debug-auth-token: $REVAULT_DEBUG_AUTH_TOKEN" \
    "$REVAULT_API_URL/rest/debug/$1"
}

onboardings="$(get_debug_collection onboardings)"
workspaces="$(get_debug_collection workspaces)"
onboarding_count="$(jq --arg workspace "$workspace" '[.[] | select(.workspaceName == $workspace)] | length' <<<"$onboardings")"
workspace_count="$(jq --arg workspace "$workspace" '[.[] | select(.name == $workspace)] | length' <<<"$workspaces")"

if ((onboarding_count > 1 || workspace_count > 1)); then
  echo "Remote state is ambiguous for workspace '$workspace'." >&2
  exit 1
fi

onboarding_id=""
onboarding_step=""
if ((onboarding_count == 1)); then
  onboarding_id="$(jq -r --arg workspace "$workspace" '.[] | select(.workspaceName == $workspace) | .id' <<<"$onboardings")"
  onboarding_step="$(jq -r --arg workspace "$workspace" '.[] | select(.workspaceName == $workspace) | .step' <<<"$onboardings")"
elif ((workspace_count == 0)); then
  create_output="$(revault create onboarding --workspace "$workspace" --mode STANDALONE)"
  printf '%s\n' "$create_output"
  onboarding_id="$(jq -Rrs '[splits("\n") | fromjson? | select(type == "object" and has("id"))] | last.id // empty' <<<"$create_output")"
  [[ -n "$onboarding_id" ]] || {
    echo "Could not read the onboarding ID from revault output." >&2
    exit 1
  }
  onboarding_step="PENDING_DEVICE_CLAIMS"
else
  echo "Workspace '$workspace' already exists; onboarding is not needed."
fi

if [[ "$onboarding_step" == "COMPLETED" && "$workspace_count" == "0" ]]; then
  echo "Onboarding '$onboarding_id' is completed, but workspace '$workspace' is missing." >&2
  exit 1
fi

if [[ -n "$onboarding_id" && "$onboarding_step" != "COMPLETED" ]]; then
  revault onboard "$onboarding_id" --salt "$salt"
  onboardings="$(get_debug_collection onboardings)"
  onboarding_step="$(jq -r --arg id "$onboarding_id" '.[] | select(.id == $id) | .step' <<<"$onboardings")"
  workspaces="$(get_debug_collection workspaces)"
  workspace_count="$(jq --arg workspace "$workspace" '[.[] | select(.name == $workspace)] | length' <<<"$workspaces")"
  [[ "$onboarding_step" == "COMPLETED" && "$workspace_count" == "1" ]] || {
    echo "Onboarding '$onboarding_id' did not produce a completed workspace; bake was not started." >&2
    exit 1
  }
else
  echo "Workspace '$workspace' is onboarded; continuing directly to bake."
fi

revault bake "$manifest" --workspace "$workspace" --salt "$salt"
echo "Desired manifest applied to '$workspace' at '$url'."

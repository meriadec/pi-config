#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 [pr-number]" >&2
  echo "Outputs JSON for active PR review threads plus top-level PR comments/review summaries." >&2
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then usage; exit 0; fi
command -v gh >/dev/null 2>&1 || { echo "error: gh CLI is required" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "error: jq is required" >&2; exit 1; }

pr_number="${1:-}"
if [[ -z "$pr_number" ]]; then pr_number="$(gh pr view --json number -q .number)"; fi
name_with_owner="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
owner="${name_with_owner%%/*}"
repo="${name_with_owner#*/}"

gql() { gh api graphql -f query="$1" -F owner="$owner" -F repo="$repo" -F number="$pr_number" ${2:+-F cursor="$2"}; }

meta_query='query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){number title url headRefName baseRefName}}}'
threads_query='query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated path line originalLine startLine originalStartLine comments(first:50){nodes{id databaseId author{login} body createdAt updatedAt url diffHunk path line originalLine outdated}}}}}}}'
comments_query='query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){comments(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id databaseId author{login} body createdAt updatedAt url}}}}}'
reviews_query='query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviews(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id databaseId author{login} body state submittedAt url}}}}}'

collect_connection() {
  local query="$1" jq_path="$2" out_file="$3" cursor='null' response has_next
  printf '[]' > "$out_file"
  while :; do
    if [[ "$cursor" == "null" ]]; then response="$(gql "$query")"; else response="$(gql "$query" "$cursor")"; fi
    jq "$jq_path.nodes" <<<"$response" | jq -s '.[0] + .[1]' "$out_file" - > "${out_file}.next"
    mv "${out_file}.next" "$out_file"
    has_next="$(jq -r "$jq_path.pageInfo.hasNextPage" <<<"$response")"
    [[ "$has_next" == "true" ]] || break
    cursor="$(jq -r "$jq_path.pageInfo.endCursor" <<<"$response")"
  done
}

meta="$(gql "$meta_query")"
threads_file="$(mktemp)"; comments_file="$(mktemp)"; reviews_file="$(mktemp)"
trap 'rm -f "$threads_file" "$comments_file" "$reviews_file"' EXIT

collect_connection "$threads_query" '.data.repository.pullRequest.reviewThreads' "$threads_file"
collect_connection "$comments_query" '.data.repository.pullRequest.comments' "$comments_file"
collect_connection "$reviews_query" '.data.repository.pullRequest.reviews' "$reviews_file"

jq -n \
  --arg owner "$owner" --arg repo "$repo" \
  --argjson pr "$(jq '.data.repository.pullRequest' <<<"$meta")" \
  --slurpfile threads "$threads_file" \
  --slurpfile comments "$comments_file" \
  --slurpfile reviews "$reviews_file" \
  '{repository:{owner:$owner,name:$repo}, pullRequest:$pr,
    activeReviewThreads:($threads[0] | map(select((.isResolved|not) and (.isOutdated|not)))),
    topLevelComments:$comments[0],
    reviewSummaries:($reviews[0] | map(select((.body // "") | length > 0)))}'

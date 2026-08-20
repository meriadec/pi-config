# Read and search

## Read an issue

```http
GET /issue/{issueKey}
```

Pass `fields` as an encoded query parameter. Request only useful fields, such as `summary,status,assignee,reporter,issuetype,priority,description,comment,attachment`. Return the key and selected field values.

## Search with JQL

```http
POST /search/jql
Content-Type: application/json
```

Payload:

```json
{
  "jql": "…",
  "fields": ["summary", "status", "assignee", "issuetype", "priority"],
  "maxResults": 50
}
```

Build it with `jq --null-input --arg jql "$JQL"`. Follow `nextPageToken` only when the user asks for all or more results; add it to the next payload.

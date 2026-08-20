# Issue writes

Add `Content-Type: application/json` and send the `jq`-built payload with `--data "$PAYLOAD"`.

## Discover values

```http
GET /field
GET /issue/{issueKey}/editmeta
GET /issue/createmeta/{projectKey}/issuetypes
GET /issue/createmeta/{projectKey}/issuetypes/{issueTypeId}
GET /user/assignable/search?project={projectKey}&query={encodedNameOrEmail}
GET /issueLinkType
```

Use metadata when field IDs, required fields, issue types, custom values, or payload shapes are unknown. Resolve people to one `accountId`. For a link, use the exact type name and confirm the inward/outward direction when unclear.

## Create

```http
POST /issue
```

```json
{ "fields": { "project": { "key": "…" }, "issuetype": { "name": "…" }, "summary": "…" } }
```

Add discovered fields to `fields`. A successful response contains `id`, `key`, and `self`.

## Edit

```http
PUT /issue/{issueKey}
```

Send only requested fields: `{"fields":{…}}`. Success is usually HTTP 204.

## Comment

```http
POST /issue/{issueKey}/comment
```

Send `{"body":ADF}`.

## Assign

```http
PUT /issue/{issueKey}/assignee
```

Assign with `{"accountId":"…"}` or unassign with `{"accountId":null}`.

## Link

```http
POST /issueLink
```

```json
{ "type": { "name": "…" }, "inwardIssue": { "key": "…" }, "outwardIssue": { "key": "…" } }
```

## Plain text as ADF

Use this value for descriptions and comment bodies:

```json
{
  "type": "doc",
  "version": 1,
  "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "…" }] }]
}
```

Build it with `jq --null-input --arg text "$TEXT"`; never interpolate text into JSON source.

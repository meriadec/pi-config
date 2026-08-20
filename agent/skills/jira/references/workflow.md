# Status change

Discover available transitions and their required fields:

```http
GET /issue/{issueKey}/transitions?expand=transitions.fields
```

Match the requested status to one available transition by exact case-insensitive name. Ask when no transition or more than one transition matches.

After approval, send:

```http
POST /issue/{issueKey}/transitions
Content-Type: application/json
```

```json
{ "transition": { "id": "…" } }
```

Add transition fields only when metadata requires them or the user requested them. Build the payload with `jq --null-input --arg id "$TRANSITION_ID"`.

# Attachments

## Upload

After approval, send one or more files:

```bash
curl --silent --show-error --fail-with-body \
  --user "$ATLASSIAN_EMAIL:$ATLASSIAN_API_TOKEN" \
  --header 'Accept: application/json' \
  --header 'X-Atlassian-Token: no-check' \
  --form "file=@$FILE" \
  "${ATLASSIAN_SITE_URL%/}/rest/api/3/issue/$ISSUE_KEY/attachments"
```

Repeat `--form "file=@$FILE"` for an approved batch. Let `curl` set the multipart content type.

## Download

Issue data gives each attachment's `id`, `filename`, and `content` URL. Preserve the filename unless the user supplies a destination.

```bash
curl --silent --show-error --fail-with-body --location \
  --user "$ATLASSIAN_EMAIL:$ATLASSIAN_API_TOKEN" \
  --output "$DESTINATION" \
  "${ATLASSIAN_SITE_URL%/}/rest/api/3/attachment/content/$ATTACHMENT_ID"
```

If Jira redirects to another host, keep `curl`'s default behavior, which does not forward Basic credentials.

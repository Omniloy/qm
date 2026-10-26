---
name: microsoft-365-files
description: Browse, search, read, and upload files in the user's OneDrive and SharePoint sites, and read SharePoint lists.
---

# OneDrive and SharePoint

Read the `microsoft-365` skill first for access and approval rules. OneDrive and
SharePoint are separate apps the user can turn on or off; both use the same drive item
tools once you have a drive id.

## Drives and items

- OneDrive: `microsoft-365_list-drives` returns the user's drive id.
- SharePoint: `search-sharepoint-sites` (by keyword) or `get-sharepoint-site-by-path`
  (hostname and server-relative path, for example `contoso.sharepoint.com` and
  `/sites/Finance`), then `list-sharepoint-site-drives` for its document libraries.
- With a drive id: `get-drive-root-item`, `list-folder-files` (children of an item),
  `get-drive-item`, and `search-onedrive-files` (searches that drive).
- Reading content: `download-bytes` returns a file's bytes as base64 through the tool, so
  use it for documents of a modest size and read only what the task needs.
  `get-download-url` returns a short-lived link the user can open themselves; share it
  with them rather than fetching it from your computer.
- Writing, after approval: `upload-file-content` creates or replaces a file from base64
  text passed as a tool argument, so keep it to small text files (notes, CSV, Markdown).

## SharePoint lists

- `list-sharepoint-site-lists`, then `list-sharepoint-site-list-items` with
  `expand=fields` to read columns, and `get-sharepoint-site-list-item` for one item.
- Changing list items isn't available here; tell the user to edit the list in SharePoint.

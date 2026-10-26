---
name: microsoft-365-files
description: Browse, search, read, and upload files in the user's OneDrive and SharePoint sites, and work with SharePoint lists.
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
- Reading content: for anything over a few KB call `get-download-url` and fetch the
  returned URL in the sandbox (`curl -L -o file "<url>"`); it needs no token and expires
  quickly. `download-bytes` returns small files inline as base64.
- Writing, after approval: `upload-file-content` for files up to 4 MB, and in OneDrive
  `create-onedrive-folder` and `move-rename-onedrive-item`.

## SharePoint lists

- `list-sharepoint-site-lists`, then `list-sharepoint-site-list-items` with
  `expand=fields` to read columns, and `get-sharepoint-site-list-item` for one item.
- `create-sharepoint-list-item` and `update-sharepoint-list-item` change data other
  people rely on: show the exact field values and get approval first.

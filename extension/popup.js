const $ = (id) => document.getElementById(id);
const ask = (message) => new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));

async function refresh() {
  const status = await ask({ type: "status" });
  if (status?.origin) $("origin").value = status.origin;
  $("conn").textContent = status?.connected ? "Connected to QM" : "Not connected";
  $("conn").className = status?.connected ? "on" : "off";
  const shared = status?.sharedTabId != null;
  $("tab").textContent = shared ? "Sharing one tab" : "No tab shared";
  $("tab").className = shared ? "on" : "off";
}

$("save").onclick = async () => {
  await ask({ type: "save-settings", origin: $("origin").value.trim(), token: $("token").value.trim() });
  // Never keep the token in the field: the popup is a page like any other.
  $("token").value = "";
  await refresh();
};

$("share").onclick = async () => {
  const result = await ask({ type: "share-current-tab" });
  if (!result?.ok) $("tab").textContent = result?.error ?? "Could not share that tab";
  await refresh();
};

$("stop").onclick = async () => {
  await ask({ type: "stop-sharing" });
  await refresh();
};

void refresh();

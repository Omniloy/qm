const $ = (id) => document.getElementById(id);
const ask = (message) => new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));

let flash = null;

async function refresh() {
  const s = await ask({ type: "status" });
  if (s?.origin) $("origin").value = s.origin;

  const sharing = s?.sharedTabId != null;
  const connected = Boolean(s?.connected);
  $("dot").className = "dot" + (sharing && connected ? " on" : "");

  if (sharing) {
    $("state").textContent = "Sharing a tab";
    $("detail").textContent = s.sharedTitle || "the tab you shared";
  } else if (connected) {
    $("state").textContent = "Connected to MiniOmni";
    $("detail").textContent = "Ready — click Share this tab";
  } else if (s?.origin && s?.hasToken) {
    $("state").textContent = "Connecting…";
    $("detail").textContent = s.origin;
  } else {
    $("state").textContent = "Not set up";
    $("detail").textContent = "Add your MiniOmni connection below";
    $("settings").open = true;
  }
}

$("save").onclick = async () => {
  await ask({ type: "save-settings", origin: $("origin").value.trim(), token: $("token").value.trim() });
  $("token").value = "";
  $("saved").textContent = "Saved ✓";
  clearTimeout(flash);
  flash = setTimeout(() => ($("saved").textContent = ""), 2500);
  await refresh();
};

$("share").onclick = async () => {
  const result = await ask({ type: "share-current-tab" });
  if (!result?.ok) {
    $("state").textContent = "Could not share";
    $("detail").textContent = result?.error ?? "try another tab";
    return;
  }
  await refresh();
};

$("stop").onclick = async () => {
  await ask({ type: "stop-sharing" });
  await refresh();
};

void refresh();

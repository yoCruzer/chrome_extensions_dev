let current;
let starting = false;
let preferencesLoaded = false;
let startError = "";
const $ = id => document.getElementById(id);
const send = message => chrome.runtime.sendMessage({ target: "background", ...message });

async function refresh() {
  try {
    const result = await send({ type: "STATUS" });
    if (!result.ok) throw new Error(result.error);
    current = result;
    $("status").textContent = startError && !result.busy ? startError : result.message;
    $("full").disabled = $("region").disabled = starting || !preferencesLoaded || result.busy;
    $("cancel").hidden = !result.busy;
  } catch (error) { $("status").textContent = error.message; }
}
for (const mode of ["full", "region"]) $(mode).onclick = async () => {
  starting = true;
  startError = "";
  $("full").disabled = $("region").disabled = true;
  try {
    const result = await send({ type: "START", mode, output: $("output").value, continuityPolicy: $("strict").checked ? "strict" : "robust" });
    if (!result.ok) throw new Error(result.error);
    window.close();
  } catch (error) { startError = error.message; $("status").textContent = startError; }
  finally { starting = false; $("full").disabled = $("region").disabled = false; }
};
$("cancel").onclick = async () => { if (current?.id) await send({ type: "CANCEL", id: current.id }); await refresh(); };
void refresh();
setInterval(refresh, 1000);

const policyKey = "continuitySitePoliciesV1";
let hostname = "";
let preferenceWrites = Promise.resolve();
const preferencesReady = (async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url || "");
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) return;
    hostname = url.hostname.toLowerCase();
    $("hostname").textContent = `当前域名：${hostname}`;
    const saved = (await chrome.storage.local.get(policyKey))[policyKey];
    const policy = saved && Object.hasOwn(saved, hostname) ? saved[hostname] : null;
    if (["robust", "strict"].includes(policy)) {
      $(policy).checked = true;
      $("remember").checked = true;
    }
  } catch {
    $("preference-status").textContent = "无法读取域名偏好，本次仍可截图。";
  } finally { $("continuity").disabled = false; $("remember").disabled = !hostname; preferencesLoaded = true; void refresh(); }
})();
function savePreference() {
  const remember = $("remember").checked;
  const policy = $("strict").checked ? "strict" : "robust";
  preferenceWrites = preferenceWrites.then(async () => {
    if (!hostname) return;
    try {
      const saved = (await chrome.storage.local.get(policyKey))[policyKey];
      const policies = saved && typeof saved === "object" && !Array.isArray(saved) ? { ...saved } : {};
      if (remember) Object.defineProperty(policies, hostname, { value: policy, enumerable: true, configurable: true, writable: true });
      else delete policies[hostname];
      await chrome.storage.local.set({ [policyKey]: policies });
      $("preference-status").textContent = "";
    } catch { $("preference-status").textContent = "域名偏好未保存，本次仍按所选模式截图。"; }
  });
}
$("remember").onchange = savePreference;
for (const policy of ["robust", "strict"]) $(policy).onchange = () => {
  if ($("remember").checked) savePreference();
};

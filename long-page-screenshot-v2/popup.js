let current;
let starting = false;
let startError = "";
const $ = id => document.getElementById(id);
const send = message => chrome.runtime.sendMessage({ target: "background", ...message });

async function refresh() {
  try {
    const result = await send({ type: "STATUS" });
    if (!result.ok) throw new Error(result.error);
    current = result;
    $("status").textContent = startError && !result.busy ? startError : result.message;
    $("full").disabled = $("region").disabled = starting || result.busy;
    $("cancel").hidden = !result.busy;
  } catch (error) { $("status").textContent = error.message; }
}
for (const mode of ["full", "region"]) $(mode).onclick = async () => {
  starting = true;
  startError = "";
  $("full").disabled = $("region").disabled = true;
  try {
    const result = await send({ type: "START", mode });
    if (!result.ok) throw new Error(result.error);
    window.close();
  } catch (error) { startError = error.message; $("status").textContent = startError; }
  finally { starting = false; $("full").disabled = $("region").disabled = false; }
};
$("cancel").onclick = async () => { if (current?.id) await send({ type: "CANCEL", id: current.id }); await refresh(); };
void refresh();
setInterval(refresh, 1000);

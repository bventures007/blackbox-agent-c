// Status page of the desktop app. Polls the supervisor and switches to the Blackbox web UI once ready.
const { invoke } = window.__TAURI__.core;

const T = {
  en: {
    steps: ["Check installation", "Start database", "Update schema", "Start services", "Open Blackbox"],
    ownerTitle: "Your personal access key",
    ownerBody: "Blackbox created your workspace. This key is shown only once. Save it in your password manager now; you need it to sign in.",
    copy: "Copy",
    copied: "Copied",
    savedCheck: "I have saved the key in a safe place.",
    continue: "Continue to Blackbox",
    missingTitle: "Access key not confirmed",
    missingBody: "Your workspace exists, but this app never confirmed that its access key was saved. If you still have the key, continue. Otherwise create a new one: all sessions and agent keys are revoked, your business data stays.",
    newKey: "Create a new access key",
    haveKey: "I still have my key",
    errorTitle: "Blackbox could not start",
    retry: "Try again",
    logs: "Open logs folder",
    data: "Data",
  },
  de: {
    steps: ["Installation prüfen", "Datenbank starten", "Schema aktualisieren", "Dienste starten", "Blackbox öffnen"],
    ownerTitle: "Ihr persönlicher Zugangsschlüssel",
    ownerBody: "Blackbox hat Ihren Arbeitsbereich angelegt. Dieser Schlüssel wird nur einmal angezeigt. Speichern Sie ihn jetzt in Ihrem Passwort-Manager; Sie brauchen ihn zum Anmelden.",
    copy: "Kopieren",
    copied: "Kopiert",
    savedCheck: "Ich habe den Schlüssel sicher gespeichert.",
    continue: "Weiter zu Blackbox",
    missingTitle: "Zugangsschlüssel nicht bestätigt",
    missingBody: "Ihr Arbeitsbereich existiert, aber diese App hat nie bestätigt, dass der Schlüssel gespeichert wurde. Wenn Sie ihn noch haben, fahren Sie fort. Sonst erstellen Sie einen neuen: Alle Sitzungen und Agentenschlüssel werden widerrufen, Ihre Geschäftsdaten bleiben erhalten.",
    newKey: "Neuen Zugangsschlüssel erstellen",
    haveKey: "Ich habe meinen Schlüssel noch",
    errorTitle: "Blackbox konnte nicht starten",
    retry: "Erneut versuchen",
    logs: "Log-Ordner öffnen",
    data: "Daten",
  },
};
const lang = (navigator.language || "en").toLowerCase().startsWith("de") ? "de" : "en";
const t = T[lang];
document.documentElement.lang = lang;
document.querySelectorAll("[data-t]").forEach((el) => (el.textContent = t[el.dataset.t]));

const $ = (id) => document.getElementById(id);
const stepIndex = { starting: 0, database: 1, migrating: 2, services: 3, restarting: 3, owner_key: 4, owner_key_missing: 4, ready: 4 };
$("steps").innerHTML = t.steps.map((s) => `<li>${s}</li>`).join("");

function show(section) {
  for (const id of ["progress", "owner", "missing", "error"]) $(id).hidden = id !== section;
}

let shownKey = null;
let leaving = false;

function render(s) {
  $("meta").textContent = `v${s.version} · ${t.data}: ${s.data_dir}`;
  if (s.phase === "ready" && s.api_url && !leaving) {
    leaving = true;
    window.location.replace(s.api_url);
    return;
  }
  if (s.phase === "owner_key" && s.owner_key) {
    if (shownKey !== s.owner_key) {
      shownKey = s.owner_key;
      $("key").textContent = s.owner_key;
      $("saved").checked = false;
      $("continue").disabled = true;
    }
    show("owner");
    return;
  }
  if (s.phase === "owner_key_missing") return show("missing");
  if (s.phase === "error") {
    $("errorText").textContent = s.error || s.message;
    return show("error");
  }
  show("progress");
  const current = stepIndex[s.phase] ?? 0;
  [...$("steps").children].forEach((li, i) => {
    li.className = i < current ? "done" : i === current ? "active" : "";
  });
  $("message").textContent = s.message;
}

async function poll() {
  try {
    render(await invoke("get_status"));
  } catch (e) {
    $("message").textContent = String(e);
  }
  if (!leaving) setTimeout(poll, 400);
}

$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("key").textContent);
  $("copy").textContent = t.copied;
  setTimeout(() => ($("copy").textContent = t.copy), 1800);
});
$("saved").addEventListener("change", (e) => ($("continue").disabled = !e.target.checked));
$("continue").addEventListener("click", () => invoke("confirm_owner_key"));
$("haveKey").addEventListener("click", () => invoke("confirm_owner_key"));
$("newKey").addEventListener("click", async () => {
  $("newKey").disabled = true;
  try {
    await invoke("reset_access");
  } catch (e) {
    $("errorText").textContent = String(e);
    show("error");
  } finally {
    $("newKey").disabled = false;
  }
});
$("retry").addEventListener("click", () => invoke("retry"));
$("logs").addEventListener("click", () => invoke("open_logs"));

poll();

// EMS admin dashboard — vanilla JS, no build step.
// All requests are same-origin under /admin, gated by the server's Basic Auth
// (the browser prompts + caches the credentials), so no auth handling here.
const requestUrl = (path) => new URL(path, window.location.origin).toString();
const api = (path) => fetch(requestUrl(`/admin/api${path}`), { credentials: "same-origin" });
async function responseJson(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const body = (await response.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    throw new Error(`Request failed (${response.status}): ${body.slice(0, 160) || "non-JSON response"}`);
  }
  return response.json();
}
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const fmtDate = (d) =>
  d ? new Date(d).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

// Map lifecycle state -> readable label + accent color class.
function stageOf(u) {
  if (u.unsubscribed) return { label: "Unsubscribed", cls: "text-muted border-line" };
  if (u.reserved) return { label: "Reserved", cls: "text-surprisePos border-surprisePos/40" };
  const t = u.last_email_type;
  if (!t) return { label: "Not started", cls: "text-muted border-line" };
  if (t === "welcome") return { label: "Welcomed", cls: "text-sadPos border-sadPos/40" };
  if (["nudge_reengage", "nudge_resend", "reengage", "resend"].includes(t))
    return { label: "Nudged", cls: "text-happy border-happy/40" };
  if (["final_nudge", "last_call"].includes(t)) return { label: "Final ask", cls: "text-anger border-anger/40" };
  if (t === "reserved_thankyou") return { label: "Reserved", cls: "text-surprisePos border-surprisePos/40" };
  return { label: t, cls: "text-muted border-line" };
}

function badge(text, cls) {
  return `<span class="inline-block text-xs px-2 py-0.5 rounded-full border ${cls}">${esc(text)}</span>`;
}

// ---- Tabs -------------------------------------------------------------------
$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.remove("tab-active"));
    tab.classList.add("tab-active");
    const name = tab.dataset.tab;
    $$("[data-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== name));
    if (name === "contacts") loadContacts();
    if (name === "emails") loadTemplates();
  });
});

// ---- Connection status ------------------------------------------------------
async function checkConnection() {
  const el = $("#conn-status");
  try {
    const r = await api("/metrics");
    if (r.status === 503) {
      el.textContent = "DB not configured";
      el.className = "text-xs px-2.5 py-1 rounded-full border border-anger/50 text-anger";
      return false;
    }
    if (!r.ok) throw new Error();
    el.textContent = "● connected";
    el.className = "text-xs px-2.5 py-1 rounded-full border border-surprisePos/40 text-surprisePos";
    return true;
  } catch {
    el.textContent = "offline";
    el.className = "text-xs px-2.5 py-1 rounded-full border border-anger/50 text-anger";
    return false;
  }
}

// ---- Overview ---------------------------------------------------------------
async function loadMetrics() {
  const cards = $("#metric-cards");
  const funnel = $("#funnel");
  cards.innerHTML = skeletonCards(6);
  try {
    const r = await api("/metrics");
    if (!r.ok) throw new Error(r.status === 503 ? "Database not configured." : "Failed to load metrics.");
    const m = await responseJson(r);

    const metricDefs = [
      { label: "Contacts", value: m.contacts, accent: "text-mist" },
      { label: "Reserved ($1)", value: m.reserved, accent: "text-surprisePos" },
      { label: "Revenue", value: `$${m.revenue_usd.toFixed(2)}`, accent: "text-happy" },
      { label: "Emails sent", value: m.emails_sent, accent: "text-sadPos" },
      { label: "Open rate", value: `${m.open_rate}%`, accent: "text-contemptPos" },
      { label: "Click rate", value: `${m.click_rate}%`, accent: "text-mist" }
    ];
    cards.innerHTML = metricDefs
      .map(
        (d) => `
      <div class="rounded-xl border border-line bg-panel p-4">
        <p class="text-xs text-muted">${d.label}</p>
        <p class="mt-2 text-2xl font-semibold ${d.accent}">${esc(d.value)}</p>
      </div>`
      )
      .join("");

    const f = m.funnel;
    const steps = [
      { label: "Not started", v: f.not_started, c: "bg-line" },
      { label: "Welcomed", v: f.welcomed, c: "bg-sadPos" },
      { label: "Nudged", v: f.nudged, c: "bg-happy" },
      { label: "Final ask", v: f.final_ask, c: "bg-anger" },
      { label: "Reserved", v: f.reserved, c: "bg-surprisePos" }
    ];
    const max = Math.max(1, ...steps.map((s) => s.v));
    funnel.innerHTML = steps
      .map(
        (s) => `
      <div class="flex items-center gap-3 py-1.5">
        <span class="w-24 text-xs text-muted shrink-0">${s.label}</span>
        <div class="flex-1 h-6 rounded bg-ink/60 overflow-hidden">
          <div class="${s.c} h-full rounded" style="width:${(s.v / max) * 100}%"></div>
        </div>
        <span class="w-10 text-right text-sm tabular-nums">${s.v}</span>
      </div>`
      )
      .join("");
  } catch (e) {
    cards.innerHTML = errorState(e.message, loadMetrics);
    funnel.innerHTML = "";
  }
}

// ---- Contacts ---------------------------------------------------------------
let contactSearchTimer;
async function loadContacts() {
  const body = $("#contacts-body");
  const q = $("#contact-search").value.trim();
  const stage = $("#contact-stage").value;
  body.innerHTML = `<tr><td colspan="7" class="px-4 py-8 text-center text-muted text-sm">Loading…</td></tr>`;
  try {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (stage) params.set("stage", stage);
    const r = await api(`/contacts?${params}`);
    if (!r.ok) throw new Error("Failed to load contacts.");
    const { contacts } = await responseJson(r);
    $("#contacts-count").textContent = `${contacts.length} contact${contacts.length === 1 ? "" : "s"}`;
    if (!contacts.length) {
      body.innerHTML = `<tr><td colspan="7" class="px-4 py-8 text-center text-muted text-sm">No contacts match.</td></tr>`;
      return;
    }
    body.innerHTML = contacts
      .map((u) => {
        const s = stageOf(u);
        return `
        <tr class="border-t border-line/60 hover:bg-ink/40 cursor-pointer" data-id="${u.id}">
          <td class="px-4 py-3">
            <div class="font-medium">${esc(u.first_name || "—")}</div>
            <div class="text-xs text-muted">${esc(u.email)}</div>
          </td>
          <td class="px-4 py-3">${badge(s.label, s.cls)}</td>
          <td class="px-4 py-3 tabular-nums text-muted">${u.total_emails_sent}</td>
          <td class="px-4 py-3 tabular-nums ${u.last_opened_at ? "text-sadPos" : "text-muted"}">${u.last_opened_at ? "✓" : "—"}</td>
          <td class="px-4 py-3 tabular-nums ${u.click_count ? "text-happy" : "text-muted"}">${u.click_count}</td>
          <td class="px-4 py-3 tabular-nums text-muted">${u.engagement_score}</td>
          <td class="px-4 py-3">${u.reserved ? badge("$1", "text-surprisePos border-surprisePos/40") : '<span class="text-muted">—</span>'}</td>
        </tr>`;
      })
      .join("");
    $$("#contacts-body tr[data-id]").forEach((row) =>
      row.addEventListener("click", () => openDrawer(row.dataset.id))
    );
  } catch (e) {
    body.innerHTML = `<tr><td colspan="7" class="px-4 py-8 text-center">${errorState(e.message, loadContacts)}</td></tr>`;
  }
}

if ($("#contact-search")) $("#contact-search").addEventListener("input", () => {
  clearTimeout(contactSearchTimer);
  contactSearchTimer = setTimeout(loadContacts, 250);
});
if ($("#contact-stage")) $("#contact-stage").addEventListener("change", loadContacts);

// ---- Contact drawer ---------------------------------------------------------
async function openDrawer(id) {
  if (!availableTemplates.length) await loadTemplates();
  const drawer = $("#drawer");
  const backdrop = $("#drawer-backdrop");
  const content = $("#drawer-content");
  backdrop.classList.remove("hidden");
  drawer.classList.remove("translate-x-full");
  content.innerHTML = `<p class="text-muted text-sm">Loading…</p>`;
  try {
    const r = await api(`/contacts/${id}`);
    if (!r.ok) throw new Error("Failed to load contact.");
    const { contact, send_log, events } = await responseJson(r);
    const s = stageOf(contact);
    const tags = Array.isArray(contact.tags) ? contact.tags : [];

    const timeline = [
      ...send_log.map((x) => ({ t: x.sent_at, kind: "sent", label: `Sent ${x.email_type}`, meta: x.status })),
      ...events.filter((e) => e.opened_at).map((e) => ({ t: e.opened_at, kind: "open", label: `Opened ${e.email_type}` })),
      ...events.filter((e) => e.clicked_at).map((e) => ({ t: e.clicked_at, kind: "click", label: `Clicked ${e.email_type}` })),
      ...events.filter((e) => e.status === "reserved").map((e) => ({ t: e.sent_at, kind: "reserve", label: "Reserved ($1)" }))
    ].sort((a, b) => new Date(b.t) - new Date(a.t));

    const dot = { sent: "bg-sadPos", open: "bg-happy", click: "bg-contemptPos", reserve: "bg-surprisePos" };

    content.innerHTML = `
      <div class="flex items-start justify-between mb-6">
        <div>
          <h2 class="text-lg font-semibold">${esc(contact.first_name || "Contact")}</h2>
          <p class="text-sm text-muted">${esc(contact.email)}</p>
        </div>
        <button id="drawer-close" class="text-muted hover:text-mist text-xl leading-none">×</button>
      </div>
      <div class="flex flex-wrap gap-2 mb-6">
        ${badge(s.label, s.cls)}
        ${tags.map((t) => badge(t, "text-contemptPos border-contemptPos/40")).join("")}
        ${contact.source ? badge(`src: ${contact.source}`, "text-muted border-line") : ""}
      </div>
      <form id="drawer-name-form" class="mb-5">
        <label class="block text-xs text-muted mb-1" for="drawer-first-name">Name used in emails</label>
        <div class="flex gap-2">
          <input id="drawer-first-name" name="first_name" value="${esc(contact.first_name || "")}" maxlength="120"
            class="min-w-0 flex-1 rounded-lg bg-ink border border-line px-3 py-2 text-sm focus:outline-none focus:border-contemptPos" />
          <button class="rounded-lg border border-line hover:border-muted px-3 py-2 text-sm transition">Save</button>
        </div>
        <p id="drawer-name-result" class="text-xs mt-2"></p>
      </form>
      <button id="drawer-send-test" class="w-full rounded-lg bg-surprisePos/90 hover:bg-surprisePos text-ink text-sm font-medium py-2 transition">Send test email to this contact</button>
      <p id="drawer-send-test-result" class="text-xs mt-2 mb-6"></p>
      <select id="drawer-template-select" class="w-full rounded-lg bg-ink border border-line px-3 py-2 text-sm text-mist focus:outline-none focus:border-contemptPos mb-2">
        ${availableTemplates.map((template) => `<option value="${esc(template.name)}">${esc(template.name.replace(/_/g, " "))}</option>`).join("")}
      </select>
      <button id="drawer-send-template" class="w-full rounded-lg bg-surprisePos/90 hover:bg-surprisePos text-ink text-sm font-medium py-2 transition">Send selected email</button>
      <p id="drawer-send-template-result" class="text-xs mt-2 mb-6"></p>
      <button id="drawer-delete-contact" class="w-full rounded-lg border border-anger/50 text-anger hover:bg-anger/10 text-sm font-medium py-2 transition">Delete contact information</button>
      <p id="drawer-delete-contact-result" class="text-xs mt-2 mb-6"></p>
      <dl class="grid grid-cols-2 gap-4 text-sm mb-8">
        ${stat("Emails sent", contact.total_emails_sent)}
        ${stat("Clicks", contact.click_count)}
        ${stat("Engagement", contact.engagement_score)}
        ${stat("Donation", contact.donation_amount ? `$${(contact.donation_amount / 100).toFixed(2)}` : "—")}
        ${stat("Last opened", fmtDate(contact.last_opened_at))}
        ${stat("Reserved at", fmtDate(contact.reserved_at))}
      </dl>
      <h3 class="text-xs uppercase tracking-wider text-muted mb-3">Email timeline</h3>
      <div class="space-y-3">
        ${
          timeline.length
            ? timeline
                .map(
                  (e) => `
          <div class="flex gap-3 items-start">
            <span class="mt-1.5 h-2 w-2 rounded-full ${dot[e.kind] || "bg-line"} shrink-0"></span>
            <div>
              <p class="text-sm">${esc(e.label)}${e.meta ? ` <span class="text-muted">· ${esc(e.meta)}</span>` : ""}</p>
              <p class="text-xs text-muted">${fmtDate(e.t)}</p>
            </div>
          </div>`
                )
                .join("")
            : `<p class="text-sm text-muted">No email activity yet.</p>`
        }
      </div>`;
    $("#drawer-close").addEventListener("click", closeDrawer);

    $("#drawer-name-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const result = $("#drawer-name-result");
      result.textContent = "Saving…";
      result.className = "text-xs mt-2 text-muted";
      try {
        const r = await fetch(`/admin/api/contacts/${contact.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ first_name: new FormData(event.target).get("first_name") })
        });
        const data = await responseJson(r);
        if (!r.ok) throw new Error(data.error || "Failed to save name.");
        result.textContent = "Name saved ✓";
        result.className = "text-xs mt-2 text-surprisePos";
        $("#drawer-content h2").textContent = data.contact.first_name || "Contact";
        loadContacts();
      } catch (err) {
        result.textContent = err.message;
        result.className = "text-xs mt-2 text-anger";
      }
    });

    $("#drawer-send-test").addEventListener("click", async () => {
      const out = $("#drawer-send-test-result");
      out.textContent = "Queuing…";
      out.className = "text-xs mt-2 mb-6 text-surprisePos";
      try {
        const r = await fetch(requestUrl("/admin/send-test"), {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: contact.id })
        });
        const d = await responseJson(r);
        if (!r.ok) throw new Error(d.error || "Failed");
        out.textContent = `Test email queued for ${contact.email} ✓`;
      } catch (err) {
        out.textContent = err.message;
        out.className = "text-xs mt-2 mb-6 text-anger";
      }
    });

    $("#drawer-send-template").addEventListener("click", async () => {
      const out = $("#drawer-send-template-result");
      const email_type = $("#drawer-template-select").value;
      out.textContent = "Queuing…";
      out.className = "text-xs mt-2 mb-6 text-surprisePos";
      try {
        const r = await fetch(requestUrl("/admin/send-template"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ id: contact.id, email_type })
        });
        const d = await responseJson(r);
        if (!r.ok) throw new Error(d.error || "Failed");
        out.textContent = `${email_type} queued for ${contact.email} ✓`;
      } catch (err) {
        out.textContent = err.message;
        out.className = "text-xs mt-2 mb-6 text-anger";
      }
    });

    $("#drawer-delete-contact").addEventListener("click", async () => {
      if (!window.confirm(`Delete ${contact.email} and suppress future imports?`)) return;
      const out = $("#drawer-delete-contact-result");
      out.textContent = "Deleting…";
      out.className = "text-xs mt-2 mb-6 text-muted";
      try {
        const r = await fetch(requestUrl(`/admin/api/contacts/${encodeURIComponent(contact.id)}`), {
          method: "DELETE",
          credentials: "same-origin"
        });
        const d = await responseJson(r);
        if (!r.ok) throw new Error(d.error || "Failed");
        closeDrawer();
        loadContacts();
      } catch (err) {
        out.textContent = err.message;
        out.className = "text-xs mt-2 mb-6 text-anger";
      }
    });
  } catch (e) {
    content.innerHTML = errorState(e.message, () => openDrawer(id));
  }
}
function closeDrawer() {
  $("#drawer").classList.add("translate-x-full");
  $("#drawer-backdrop").classList.add("hidden");
}
$("#drawer-backdrop").addEventListener("click", closeDrawer);
function stat(label, value) {
  return `<div><dt class="text-xs text-muted">${label}</dt><dd class="mt-0.5">${esc(value)}</dd></div>`;
}

// ---- Actions ----------------------------------------------------------------
function resultMsg(key, ok, text) {
  const el = $(`[data-result="${key}"]`);
  el.textContent = text;
  el.className = `text-xs mt-3 ${ok ? "text-surprisePos" : "text-anger"}`;
}

$("#signup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const r = await fetch(requestUrl("/signup"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: fd.get("email"), first_name: fd.get("first_name"), source: "admin_console" })
    });
    const d = await responseJson(r);
    if (!r.ok) throw new Error(d.error || "Failed");
    resultMsg("signup", true, d.status === "suppressed" ? "Email is on the suppression list — skipped." : "Added to the Phase A funnel ✓");
    e.target.reset();
  } catch (err) {
    resultMsg("signup", false, err.message);
  }
});

$("#csv-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  resultMsg("csv", true, "Uploading…");
  try {
    const r = await fetch(requestUrl("/upload-csv"), { method: "POST", body: fd });
    const d = await responseJson(r);
    if (!r.ok) throw new Error(d.error || "Failed");
    resultMsg("csv", true, `Imported ${d.imported} contact(s) ✓`);
    e.target.reset();
  } catch (err) {
    resultMsg("csv", false, err.message);
  }
});

$("#campaign-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email_type = new FormData(e.target).get("email_type");
  resultMsg("campaign", true, "Queuing…");
  try {
    const r = await fetch(requestUrl("/admin/campaign-email"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ email_type })
    });
    const d = await responseJson(r);
    if (!r.ok) throw new Error(d.error || "Failed");
    resultMsg("campaign", true, `Queued "${email_type}" for ${d.count} recipient(s) ✓`);
  } catch (err) {
    resultMsg("campaign", false, err.message);
  }
});

$("#send-test-btn").addEventListener("click", async () => {
  resultMsg("send-test", true, "Queuing…");
  try {
    const r = await fetch(requestUrl("/admin/send-test"), {
      method: "POST",
      credentials: "same-origin"
    });
    const d = await responseJson(r);
    if (!r.ok) throw new Error(d.error || "Failed");
    resultMsg("send-test", true, `Queued test email for ${d.count} contact(s) ✓`);
  } catch (err) {
    resultMsg("send-test", false, err.message);
  }
});

$("#custom-email-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  resultMsg("custom-email", true, "Sending…");
  try {
    const values = Object.fromEntries(new FormData(form).entries());
    const r = await fetch("/admin/custom-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(values)
    });
    const data = await responseJson(r);
    if (!r.ok) throw new Error(data.error || "Failed to send email.");
    resultMsg("custom-email", true, `Custom email sent to ${data.email} ✓`);
    form.reset();
  } catch (err) {
    resultMsg("custom-email", false, err.message);
  }
});

// ---- Emails -----------------------------------------------------------------
let templatesLoaded = false;
let availableTemplates = [];
function setTemplateEditorMode(form) {
  const useMjml = form.elements.editor_mode.value === "mjml";
  const builderFields = $("#template-builder-fields");
  const mjmlFields = $("#template-mjml-fields");
  builderFields.disabled = useMjml;
  builderFields.classList.toggle("hidden", useMjml);
  mjmlFields.disabled = !useMjml;
  mjmlFields.classList.toggle("hidden", !useMjml);
}

const templateForm = $("#template-form");
if (templateForm) {
  templateForm.elements.editor_mode.addEventListener("change", () => setTemplateEditorMode(templateForm));
}

async function loadTemplates() {
  if (templatesLoaded) return;
  const list = $("#template-list");
  try {
    const r = await api("/templates");
    const { templates, manual_phase_b } = await responseJson(r);
    availableTemplates = templates;

    // Populate the selected-email dropdown with every saved template.
    const sel = $('#campaign-form select[name="email_type"]');
    sel.querySelectorAll("option:not(:first-child)").forEach((option) => option.remove());
    templates.forEach((t) => {
      const o = document.createElement("option");
      o.value = t.name;
      o.textContent = t.name.replace(/_/g, " ");
      sel.appendChild(o);
    });

    const phaseColor = { A: "text-sadPos", B: "text-happy", conversion: "text-surprisePos" };
    list.innerHTML = templates
      .map(
        (t) => `
      <div data-name="${esc(t.name)}" class="tpl-item flex items-stretch rounded-lg border border-line bg-panel hover:border-muted transition">
        <button class="tpl-preview flex-1 text-left px-4 py-3">
        <div class="flex items-center justify-between">
          <span class="text-sm">${esc(t.name.replace(/_/g, " "))}</span>
          <span class="text-xs ${phaseColor[t.phase] || "text-muted"}">Phase ${t.phase}</span>
        </div>
        </button>
        ${t.phase === "custom" ? `<button data-name="${esc(t.name)}" class="tpl-delete px-3 text-xs text-anger hover:bg-anger/10" title="Delete template">Delete</button>` : ""}
      </div>`
      )
      .join("");
    $$(".tpl-preview").forEach((btn) =>
      btn.addEventListener("click", () => {
        const item = btn.closest(".tpl-item");
        $$(".tpl-item").forEach((b) => b.classList.remove("border-contemptPos"));
        item.classList.add("border-contemptPos");
        $("#preview-title").textContent = item.dataset.name.replace(/_/g, " ");
        $("#template-frame").src = `/admin/api/templates/${encodeURIComponent(item.dataset.name)}`;
      })
    );
    $$(".tpl-delete").forEach((btn) => btn.addEventListener("click", async () => {
      const name = btn.dataset.name;
      if (!window.confirm(`Delete the ${name} template?`)) return;
      const r = await fetch(requestUrl(`/admin/api/templates/${encodeURIComponent(name)}`), { method: "DELETE", credentials: "same-origin" });
      const d = await responseJson(r);
      if (!r.ok) return resultMsg("template", false, d.error || "Failed to delete template.");
      templatesLoaded = false;
      loadTemplates();
      resultMsg("template", true, `Deleted "${name}".`);
    }));
    templatesLoaded = true;
  } catch (e) {
    list.innerHTML = errorState("Failed to load templates.", () => {
      templatesLoaded = false;
      loadTemplates();
    });
  }
}

if ($("#template-form")) $("#template-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  resultMsg("template", true, "Adding…");
  try {
    const r = await fetch(requestUrl("/admin/api/templates"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ name: form.get("name"), mjml: templateMhtml(e.target) })
    });
    const d = await responseJson(r);
    if (!r.ok) throw new Error(d.error || "Failed to add template.");
    e.target.reset();
    setTemplateEditorMode(e.target);
    templatesLoaded = false;
    loadTemplates();
    resultMsg("template", true, "Template added ✓");
  } catch (err) {
    resultMsg("template", false, err.message);
  }
});

if ($("#template-draft-btn")) $("#template-draft-btn").addEventListener("click", async () => {
  const form = $("#template-form");
  const name = form.elements.name.value.trim() || "untitled draft";
  const mjml = templateMhtml(form);
  resultMsg("template", true, "Rendering draft…");
  try {
    const r = await fetch(requestUrl("/admin/api/templates/preview"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ mjml })
    });
    const html = await r.text();
    if (!r.ok) throw new Error(html.replace(/<[^>]+>/g, "").trim() || "Failed to preview draft.");
    $("#preview-title").textContent = `Draft: ${name}`;
    $("#template-frame").srcdoc = html;
    resultMsg("template", true, "Draft preview ready. Add the template when it is ready to save.");
  } catch (err) {
    resultMsg("template", false, err.message);
  }
});

function xmlText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function templateMhtml(form) {
  if (form.elements.editor_mode.value === "mjml") return form.elements.mjml_source.value.trim();
  const value = (name) => form.elements[name].value.trim();
  const paragraphs = value("body")
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((paragraph) => `<mj-text>${xmlText(paragraph).replace(/\n/g, "<br />")}</mj-text>`)
    .join("");
  const signoff = value("signoff");
  const button = value("button_text") && value("button_link")
    ? `<mj-button href="${xmlText(value("button_link"))}" background-color="#7B4ED6" color="#ffffff" font-size="16px" font-weight="bold" border-radius="8px" padding="24px 0 8px 0" inner-padding="14px 28px">${xmlText(value("button_text"))}</mj-button>`
    : "";
  return `<mjml><mj-head><mj-attributes><mj-all font-family="Helvetica, Arial, sans-serif" /><mj-text font-size="16px" line-height="1.6" color="#2A2F42" padding="8px 0" /></mj-attributes><mj-preview>${xmlText(value("preheader"))}</mj-preview></mj-head><mj-body background-color="#F4F6FB"><mj-section padding="24px 0 8px 0"><mj-column><mj-text align="center" font-size="20px" font-weight="bold" color="#7B4ED6">${xmlText(value("title"))}</mj-text><mj-text align="center" font-size="12px" letter-spacing="1px" color="#9AA3B8">${xmlText(value("eyebrow"))}</mj-text></mj-column></mj-section><mj-section background-color="#ffffff" border-radius="12px" padding="16px 24px"><mj-column><mj-text>Hi {{first_name}},</mj-text>${paragraphs}${signoff ? `<mj-text>${xmlText(signoff).replace(/\n/g, "<br />")}</mj-text>` : ""}${button}</mj-column></mj-section></mj-body></mjml>`;
}

if ($("#queue-toggle-btn")) $("#queue-toggle-btn").addEventListener("click", async () => {
  const button = $("#queue-toggle-btn");
  const paused = button.dataset.paused === "true";
  resultMsg("queue", true, paused ? "Resuming…" : "Pausing…");
  try {
    const r = await fetch(requestUrl(`/admin/api/queue/${paused ? "resume" : "pause"}`), {
      method: "POST",
      credentials: "same-origin"
    });
    const data = await responseJson(r);
    if (!r.ok) throw new Error(data.error || "Failed to update queue.");
    updateQueueControl(data.paused);
  } catch (err) {
    resultMsg("queue", false, err.message);
  }
});

function updateQueueControl(paused) {
  const button = $("#queue-toggle-btn");
  if (!button) return;
  button.dataset.paused = String(paused);
  button.textContent = paused ? "Resume queue" : "Pause queue";
  button.className = `w-full rounded-lg border text-sm font-medium py-2 transition ${paused ? "border-surprisePos/60 text-surprisePos hover:bg-surprisePos/10" : "border-anger/50 text-anger hover:bg-anger/10"}`;
  resultMsg("queue", true, paused ? "Queue paused. Existing jobs are preserved." : "Queue resumed.");
}

async function loadQueueStatus() {
  try {
    const r = await api("/queue");
    if (!r.ok) throw new Error("Failed to load queue status.");
    updateQueueControl((await responseJson(r)).paused);
  } catch (err) {
    resultMsg("queue", false, err.message);
  }
}

// ---- Shared UI bits ---------------------------------------------------------
function skeletonCards(n) {
  return Array.from({ length: n })
    .map(() => `<div class="rounded-xl border border-line bg-panel p-4 animate-pulse"><div class="h-3 w-16 bg-line rounded"></div><div class="mt-3 h-6 w-12 bg-line rounded"></div></div>`)
    .join("");
}
function errorState(msg, retry) {
  const id = "retry-" + Math.random().toString(36).slice(2);
  setTimeout(() => {
    const retryButton = $(`#${id}`);
    if (retryButton) retryButton.addEventListener("click", retry);
  }, 0);
  return `<div class="col-span-full text-center py-6">
    <p class="text-sm text-anger mb-3">${esc(msg)}</p>
    <button id="${id}" class="text-xs px-3 py-1.5 rounded-lg border border-line hover:border-muted">Retry</button>
  </div>`;
}

// ---- Boot -------------------------------------------------------------------
$("#refresh-btn").addEventListener("click", () => {
  const active = $(".tab-active").dataset.tab;
  checkConnection();
  if (active === "overview") loadMetrics();
  else if (active === "contacts") loadContacts();
  else if (active === "emails") {
    templatesLoaded = false;
    loadTemplates();
  }
});

(async function boot() {
  await checkConnection();
  loadMetrics();
  loadTemplates(); // also fills the campaign dropdown
  loadQueueStatus();
})();

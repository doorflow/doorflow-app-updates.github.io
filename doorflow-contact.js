(function () {
"use strict";

/* ============================================
     Lifecycle logger
     ============================================
     Single namespace for every meaningful event in this flow. The aim
     is that reading the console afterwards lets you reconstruct what
     the user did and what the system did in response — useful for:
       - diagnosing call-flow oddities (the "stuck on dialling after
         voicemail" bug we hit earlier)
       - understanding where users drop off
       - confirming a deployment is wired up correctly

     Categories:
       session   — page load, rehydration, abandonment
       step      — step transitions
       form      — field validation outcomes, submissions
       calendar  — calendar render, slot selection, timezone
       call      — every stage of the c2c call lifecycle
       persist   — what we send to connect.doorflow.com
       attendee  — additional attendee adds/removes
       bot       — bot check decisions
       widget    — c2c widget-specific events

     Levels:
       log    — normal lifecycle (happy path)
       warn   — non-error oddities (poll retry, fallback used,
                unrecognised API string)
       error  — genuine failures (call init failed, status timeout)

     Toggle off in the browser:  localStorage.setItem('doorflow:debug', 'false')
     Toggle back on:             localStorage.removeItem('doorflow:debug')
     Errors are always shown regardless of the flag. */
  const LOG = (() => {
    function isDebug() {
      try {
        const v = localStorage.getItem("doorflow:debug");
        return v === null ? true : v !== "false";
      } catch (e) { return true; }
    }
    function emit(level, category, event, payload) {
      // Always show errors. Suppress others when debug is off.
      if (level !== "error" && !isDebug()) return;
      const tag = `%c[doorflow:${category}]%c ${event}`;
      const tagStyle = level === "error" ? "color:#c4392b;font-weight:600"
                     : level === "warn"  ? "color:#b3541e;font-weight:600"
                     :                     "color:#1c7e63;font-weight:600";
      const fn = level === "error" ? console.error
               : level === "warn"  ? console.warn
               :                     console.log;
      if (payload !== undefined) fn(tag, tagStyle, "color:inherit", payload);
      else                       fn(tag, tagStyle, "color:inherit");
    }
    return {
      log:   (cat, ev, p) => emit("log",   cat, ev, p),
      warn:  (cat, ev, p) => emit("warn",  cat, ev, p),
      error: (cat, ev, p) => emit("error", cat, ev, p),
    };
  })();

  /* Build version stamp.
     The string "2026-05-07T13:31:03Z" is replaced at build time with an
     ISO timestamp + short hash. If you ever see the literal token
     below in the console, it means the file was deployed without
     going through the build (run `node build.mjs`). */
  const BUILD_VERSION = "2026-05-07T13:31:03Z";

  // Always log the version on boot — both as a structured field on the
  // session.boot event and as a separate banner line so it's easy to
  // spot at a glance when scrolling the console.
  console.log("%c[doorflow] build %c" + BUILD_VERSION,
    "color:#1c7e63;font-weight:600", "color:#4b5563");
  LOG.log("session", "boot", {
    version: BUILD_VERSION,
    ua: navigator.userAgent,
    href: location.href,
  });

  /* ============================================
     Session persistence
     ============================================
     The form lives in sessionStorage under SESSION_KEY. This survives:
       - page reloads (intentional or accidental)
       - returning from a tel: link or external app on mobile
       - iOS Safari aggressively unloading background tabs

     It does NOT survive closing the tab/window — by design. We don't
     want to "remember" someone forever (privacy + stale data).

     Lifecycle:
       - on load: try to rehydrate. If found, restore form values and
         return them to the step they were on.
       - on every meaningful state change: re-save.
       - on successful confirmation (step 4): clear, since they're done. */
  const SESSION_KEY = "df_contact_session_v1";

  function safeSessionGet() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); }
    catch (e) { return null; }
  }
  function safeSessionSet(value) {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(value)); }
    catch (e) { /* private browsing or storage full — silently no-op */ }
  }
  function safeSessionClear() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
  }

  const restored = safeSessionGet();
  if (restored) {
    LOG.log("session", "rehydrated", {
      step: restored.step,
      project: restored.project,
      hasForm: !!(restored.fname || restored.email),
      hasBooking: !!(restored.selectedDate && restored.selectedSlot),
      savedAt: restored.savedAt,
    });
  } else {
    LOG.log("session", "fresh", {});
  }

  /* ============================================
     State
     ============================================
     If a previous session exists in sessionStorage we re-use its
     sessionId — that way connect.doorflow.com sees this as the same
     lead and updates the same record rather than creating a new one. */
  const state = {
    sessionId: (restored && restored.sessionId)
      ? restored.sessionId
      : ((crypto && crypto.randomUUID) ? crypto.randomUUID()
         : 'df-' + Math.random().toString(36).slice(2) + Date.now().toString(36)),
    formLoadedAt: Date.now(),
    step: (restored && restored.step) || 1,
    project: (restored && restored.project) || null,
    fname:    (restored && restored.fname)    || "",
    lname:    (restored && restored.lname)    || "",
    company:  (restored && restored.company)  || "",
    email:    (restored && restored.email)    || "",
    phoneRaw: (restored && restored.phoneRaw) || "",
    phoneE164:(restored && restored.phoneE164)|| "",
    phoneCountry: (restored && restored.phoneCountry) || "",
    ext:      (restored && restored.ext)      || "",
    selectedDate: (restored && restored.selectedDate) ? new Date(restored.selectedDate) : null,
    selectedSlot: (restored && restored.selectedSlot) || null,
    selectedTimezone: (restored && restored.selectedTimezone) || null,
    calMonth: null,
    attendees: (restored && restored.attendees) || [],
    jsToken: null,
  };
  state.jsToken = btoa(state.sessionId + ":" + state.formLoadedAt).slice(0, 24);

  /* Re-save whatever's in state. Called after any meaningful change. */
  function saveSession() {
    safeSessionSet({
      sessionId: state.sessionId,
      step: state.step,
      project: state.project,
      fname: state.fname, lname: state.lname,
      company: state.company,
      email: state.email,
      phoneRaw: state.phoneRaw,
      phoneE164: state.phoneE164,
      phoneCountry: state.phoneCountry,
      ext: state.ext,
      selectedDate: state.selectedDate ? state.selectedDate.toISOString() : null,
      selectedSlot: state.selectedSlot,
      selectedTimezone: state.selectedTimezone,
      attendees: state.attendees,
      savedAt: new Date().toISOString(),
    });
  }

  const projectLabels = {
    single: "Just the front door",
    multi: "A few doors",
    enterprise: "A larger access project",
    help: "Needs a hand getting started",
  };
  // Shorter labels for the header chip — long ones get awkward on mobile.
  const projectChips = {
    single: "Front door",
    multi: "A few doors",
    enterprise: "Larger project",
    help: "Getting started",
  };

  /* ============================================
     Persistence stub
     ============================================
     POSTs each meaningful step to connect.doorflow.com so partial
     leads aren't lost. The endpoint is currently a stub — it returns
     404 until you wire it up server-side.

     During local development the network path produces noisy console
     errors. To keep things quiet we skip the fetch entirely when we
     detect a non-production host. The console.log still fires every
     time so you can see what would have been sent.

     PRODUCTION_HOSTS controls this — add your real domains there.
     Anything else (localhost, file://, preview iframes, IP literals)
     gets logged but not POSTed. */
  const PRODUCTION_HOSTS = ["doorflow.com", "www.doorflow.com"];
  const isProductionHost = PRODUCTION_HOSTS.some(h =>
    typeof location !== "undefined" && location.hostname === h
  );

  function persist(stage, payload = {}) {
    const body = {
      sessionId: state.sessionId,
      jsToken: state.jsToken,
      stage,
      at: new Date().toISOString(),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...payload,
    };
    LOG.log("persist", stage, body);

    // Save locally regardless — this is what keeps the form recoverable
    // across reloads.
    saveSession();

    // In dev, stop here. The endpoint isn't built yet and the 404s
    // are not useful information.
    if (!isProductionHost) return;

    try {
      fetch("https://connect.doorflow.com/api/lead-progress", {
        method: "POST",
        mode: "no-cors",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => {});
    } catch (e) {}
  }

  /* ============================================
     Bot defenses
     ============================================ */
  function passesBotChecks() {
    if (document.getElementById("df-hp_company_url").value.trim()) {
      LOG.warn("bot", "rejected", { reason: "honeypot_filled" });
      return false;
    }
    const elapsed = Date.now() - state.formLoadedAt;
    if (elapsed < 2500) {
      LOG.warn("bot", "rejected", { reason: "too_fast", elapsedMs: elapsed });
      return false;
    }
    if (!state.jsToken) {
      LOG.warn("bot", "rejected", { reason: "no_js_token" });
      return false;
    }
    return true;
  }

  /* ============================================
     Step nav + header context
     ============================================ */
  const panels = document.querySelectorAll(".panel");
  const progressFill = document.getElementById("df-progressFill");
  const brandContext = document.getElementById("df-brandContext");
  const brandContextText = document.getElementById("df-brandContextText");

  function refreshHeaderContext() {
    // Header chip: shows the project chip from step 2 onwards. Empty on
    // step 1 (no choice yet) and on step 4 (the title carries enough
    // context — "Hello Bob — when shall we speak?" already personalises).
    if (state.step === 1 || state.step === 4 || !state.project) {
      brandContext.classList.add("is-empty");
      brandContextText.textContent = "";
      return;
    }
    brandContextText.textContent = projectChips[state.project] || "";
    brandContext.classList.toggle("is-empty", !brandContextText.textContent);
  }

  function setStep(n) {
    const from = state.step;
    state.step = n;
    panels.forEach(p => p.classList.toggle("is-active", String(p.dataset.panel) === String(n)));
    progressFill.style.width = (Math.min(n, 3) / 3 * 100) + "%";
    const body = document.querySelector(`.panel[data-panel="${n}"] .panel-body`);
    if (body) body.scrollTop = 0;
    refreshHeaderContext();
    saveSession();
    LOG.log("step", "transitioned", { from, to: n });
    // Step-leave hook: if we left step 3, the availability poll
    // shouldn't keep running. Each step that needs polling owns
    // starting it on entry.
    if (from === 3 && n !== 3 && typeof stopAvailabilityPolling === "function") {
      stopAvailabilityPolling();
      if (typeof cancelCompletedAutoReset === "function") cancelCompletedAutoReset();
    }
  }

  document.querySelectorAll("[data-back]").forEach(b => {
    b.addEventListener("click", () => {
      cancelAutoProgress();
      setStep(state.step - 1);
    });
  });

  /* ============================================
     Auto-progress
     ============================================
     When a step has all the info it needs, give the user a beat to
     review, then advance for them. The button gets a soft pulse and
     a small "Continuing in a moment…" hint appears above it with
     an "actually wait" link to cancel.

     Cancellation triggers:
       - any click outside the CTA (forms, options, calendar, etc.)
       - any keystroke
       - clicking the "wait" link in the hint
       - the form becoming invalid again

     The total wait is ~1.6s — long enough to read, short enough to
     keep momentum. */
  /* Auto-progress was tried and removed — turns out automatic
     advancement on a contact form feels intrusive even with a
     cancel affordance. Setting AUTO_PROGRESS_MS to -1 disables
     it; the machinery below is left intact so it can be turned
     back on with a single-line change if ever needed. */
  const AUTO_PROGRESS_MS = -1;
  let autoProgressTimer = null;
  let autoProgressBtn = null;
  let autoProgressHint = null;

  function cancelAutoProgress() {
    if (autoProgressTimer) {
      clearTimeout(autoProgressTimer);
      autoProgressTimer = null;
    }
    if (autoProgressBtn) {
      autoProgressBtn.classList.remove("btn-pulse");
      autoProgressBtn = null;
    }
    if (autoProgressHint) {
      autoProgressHint.classList.remove("is-visible");
      autoProgressHint.innerHTML = "";
      autoProgressHint = null;
    }
  }

  function scheduleAutoProgress(button, hintEl, label) {
    cancelAutoProgress();
    if (AUTO_PROGRESS_MS < 0) return;   // disabled — honour the sentinel
    if (!button || button.disabled) return;
    autoProgressBtn = button;
    autoProgressHint = hintEl;

    if (hintEl) {
      hintEl.innerHTML = `${label}<button type="button" id="autoCancelBtn">wait</button>`;
      hintEl.classList.add("is-visible");
      const wait = document.getElementById("df-autoCancelBtn");
      if (wait) wait.addEventListener("click", cancelAutoProgress);
    }
    button.classList.add("btn-pulse");

    autoProgressTimer = setTimeout(() => {
      // Re-check the button is still enabled (state may have flipped).
      if (button && !button.disabled) {
        cancelAutoProgress();
        button.click();
      } else {
        cancelAutoProgress();
      }
    }, AUTO_PROGRESS_MS);
  }

  /* Any meaningful interaction while auto-progress is pending should
     cancel it. We bind a global click + keydown listener; they're
     cheap and only do work while the timer is set. */
  document.addEventListener("click", (e) => {
    if (!autoProgressTimer) return;
    // Don't cancel on a click of the CTA itself — let it through.
    if (autoProgressBtn && autoProgressBtn.contains(e.target)) return;
    cancelAutoProgress();
  }, true);
  document.addEventListener("keydown", () => {
    if (autoProgressTimer) cancelAutoProgress();
  }, true);

  /* ============================================
     Step 1
     ============================================ */
  const nextBtn1 = document.getElementById("df-nextBtn1");
  document.querySelectorAll(".panel[data-panel='1'] .option").forEach(el => {
    el.addEventListener("click", () => {
      document.querySelectorAll(".panel[data-panel='1'] .option").forEach(o => {
        o.classList.remove("selected");
        o.setAttribute("aria-checked", "false");
      });
      el.classList.add("selected");
      el.setAttribute("aria-checked", "true");
      state.project = el.dataset.value;
      nextBtn1.disabled = false;
      saveSession();
      LOG.log("form", "project_selected", { project: state.project });

      const callout = document.getElementById("df-installerCallout");
      if (state.project === "help") {
        callout.querySelector("div").innerHTML =
          "<strong>You're in good hands.</strong> Tell us what you're trying to do and we'll work backwards from there — what doors, who needs in, what you've already got. No jargon required.";
      } else {
        callout.querySelector("div").innerHTML =
          "<strong>Twenty minutes saves a fortnight.</strong> We don't install ourselves — DoorFlow is fitted by local contractors, and we have a network of trusted installers we can introduce you to. A short call lets us match you to the right one and brief them properly.";
      }

      // Auto-advance after a beat so they don't have to chase the button.
      scheduleAutoProgress(nextBtn1, document.getElementById("df-autoHint1"), "Continuing in a moment…");
    });
  });
  nextBtn1.addEventListener("click", () => {
    if (!state.project) return;
    persist("project_selected", { project: state.project });
    setStep(2);
  });

  /* ============================================
     Step 2 — name capitalisation
     ============================================
     Per-word logic (the field-level rule was too coarse — "von dumesson"
     used to become "Von Dumesson" because the field as a whole was all
     lowercase). Each word is now evaluated independently:

       For each word:
         1. Does it have ANY uppercase letter? (e.g. "Von", "McDonald",
            "OBrien") → leave it alone. The user has signalled intent
            for THIS word.
         2. Is it ALL lowercase?
              a. Known particle ("von", "de", "van", ...) → leave it
                 lowercase. That's correct in free-text name fields.
              b. Otherwise → capitalise first letter ("dumesson" -> "Dumesson").
         3. Is it ALL UPPERCASE? Almost always caps-lock or shouting,
            not deliberate styling → recase first letter only ("SMITH"
            -> "Smith").

     Walk-throughs:
       "von dumesson"   -> "von" (particle, keep) + "Dumesson"  ✓
       "Von Dumesson"   -> kept entirely (both have uppercase)  ✓
       "von Dumesson"   -> "von" kept + "Dumesson" kept         ✓
       "Von dumesson"   -> "Von" kept + "Dumesson" capitalised  ✓
       "ada lovelace"   -> "Ada Lovelace"                       ✓
       "ADA LOVELACE"   -> "Ada Lovelace"                       ✓
       "mary-jane"      -> "Mary-Jane"                          ✓
       "o'brien"        -> "O'Brien"                            ✓

     Applied on blur only.
     ============================================ */
  const NAME_PARTICLES = new Set([
    "van", "von", "de", "del", "della", "di", "du",
    "la", "le", "der", "ter", "ten", "den", "af", "av",
    "bin", "ibn", "y", "da", "das", "dos", "do", "el", "al",
  ]);

  function fixWord(word) {
    if (!word) return word;
    const hasUpper = /[A-Z]/.test(word);
    const hasLower = /[a-z]/.test(word);

    // Mixed case → user signalled intent, keep as-is.
    if (hasUpper && hasLower) return word;

    // All lowercase: keep particles, capitalise everything else.
    if (hasLower && !hasUpper) {
      if (NAME_PARTICLES.has(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    }

    // All uppercase (or no letters at all): recase to first-cap.
    // Particle treatment doesn't apply here — if someone typed "VON"
    // they used caps lock, not the convention.
    if (hasUpper && !hasLower) {
      const lower = word.toLowerCase();
      if (NAME_PARTICLES.has(lower)) return lower;
      return word.charAt(0).toUpperCase() + lower.slice(1);
    }

    return word;
  }

  function smartCapitalise(input) {
    const trimmed = input.trim();
    if (!trimmed) return trimmed;
    // Split on spaces, hyphens, apostrophes (straight + curly) — and
    // run fixWord on each token while preserving the separators.
    return trimmed.replace(/([^\s\-'’]+)/g, (word) => fixWord(word));
  }

  /* ============================================
     Step 2 — phone + extension
     ============================================
     Phone validation strategy:
       - Strip non-digits while keeping +, then convert to E.164.
       - Validate against per-country length rules (and a few prefix
         sanity checks where they're tight, like UK mobiles starting 7).
       - Anything outside our country table falls back to the generic
         E.164 envelope (7–15 digits).
     This is best-effort, captures ~95% of typos without a 140KB
     libphonenumber bundle. Upgrade to libphonenumber-js if you need
     stricter validation for a particular market. */
  const COUNTRY_CODES = {
    GB: "44", US: "1", CA: "1", IE: "353", FR: "33", DE: "49",
    NL: "31", BE: "32", ES: "34", IT: "39", PT: "351", CH: "41",
    AT: "43", SE: "46", NO: "47", DK: "45", FI: "358", PL: "48",
    AU: "61", NZ: "64", JP: "81", SG: "65", HK: "852", AE: "971",
    IN: "91", ZA: "27",
  };

  /* Digit-length expectations and prefix patterns per country.
     - lens: array of valid total digit lengths AFTER the country code
     - prefix: regex that the national number (sans country code) must
       match. Only set where rules are reasonably crisp; left undefined
       otherwise to avoid false rejections. */
  const PHONE_RULES = {
    GB: { lens: [10],          prefix: /^[1-9]/ },           // UK: 10 digits, can't start 0
    US: { lens: [10],          prefix: /^[2-9]\d{2}[2-9]/ }, // NANP: area code 2-9, exchange 2-9
    CA: { lens: [10],          prefix: /^[2-9]\d{2}[2-9]/ },
    IE: { lens: [9, 10],       prefix: /^[1-9]/ },
    FR: { lens: [9],           prefix: /^[1-9]/ },
    DE: { lens: [10, 11, 12] },                              // very variable
    NL: { lens: [9],           prefix: /^[1-9]/ },
    BE: { lens: [8, 9],        prefix: /^[1-9]/ },
    ES: { lens: [9],           prefix: /^[6-9]/ },
    IT: { lens: [9, 10, 11] },
    PT: { lens: [9],           prefix: /^[2-9]/ },
    CH: { lens: [9],           prefix: /^[1-9]/ },
    AT: { lens: [10, 11, 12, 13] },
    SE: { lens: [7, 8, 9],     prefix: /^[1-9]/ },
    NO: { lens: [8],           prefix: /^[2-9]/ },
    DK: { lens: [8],           prefix: /^[2-9]/ },
    FI: { lens: [9, 10, 11] },
    PL: { lens: [9],           prefix: /^[1-9]/ },
    AU: { lens: [9],           prefix: /^[2-9]/ },
    NZ: { lens: [8, 9, 10] },
    JP: { lens: [10],          prefix: /^[1-9]/ },
    SG: { lens: [8],           prefix: /^[3689]/ },
    HK: { lens: [8],           prefix: /^[2-9]/ },
    AE: { lens: [8, 9] },
    IN: { lens: [10],          prefix: /^[6-9]/ },
    ZA: { lens: [9],           prefix: /^[1-8]/ },
  };

  function detectCountry() {
    try {
      const region = (new Intl.DateTimeFormat().resolvedOptions().locale || "")
        .split("-").pop().toUpperCase();
      if (COUNTRY_CODES[region]) return region;
    } catch (e) {}
    const lang = (navigator.language || "en-GB");
    const region = lang.split("-").pop().toUpperCase();
    if (COUNTRY_CODES[region]) return region;
    return "GB";
  }

  function toE164(input) {
    const raw = (input || "").trim();
    if (!raw) return { e164: "", country: "" };
    const country = detectCountry();
    const cc = COUNTRY_CODES[country];
    if (raw.startsWith("+")) {
      const digits = raw.replace(/[^\d]/g, "");
      return { e164: digits ? "+" + digits : "", country };
    }
    if (raw.startsWith("00")) {
      const digits = raw.replace(/[^\d]/g, "").replace(/^00/, "");
      return { e164: digits ? "+" + digits : "", country };
    }
    let digits = raw.replace(/[^\d]/g, "");
    digits = digits.replace(/^0/, "");
    return { e164: digits ? "+" + cc + digits : "", country };
  }

  /* Try to identify which country an E.164 number belongs to so we can
     pick the right validation rule. We match country codes longest-first
     to handle 1-digit codes (US/CA) vs 3-digit codes (GBR is "44"). */
  function countryFromE164(e164) {
    if (!e164 || !e164.startsWith("+")) return null;
    const digits = e164.slice(1);
    // Sort country codes by length desc so we don't match "1" inside "12".
    const entries = Object.entries(COUNTRY_CODES).sort((a, b) => b[1].length - a[1].length);
    for (const [country, code] of entries) {
      if (digits.startsWith(code)) return { country, code, national: digits.slice(code.length) };
    }
    return null;
  }

  function validateE164(e164) {
    if (!e164 || !e164.startsWith("+")) return false;
    const digits = e164.slice(1);
    // Generic E.164 envelope first.
    if (digits.length < 7 || digits.length > 15) return false;

    // If we recognise the country, apply tighter rules.
    const match = countryFromE164(e164);
    if (match) {
      const rule = PHONE_RULES[match.country];
      if (rule) {
        if (rule.lens && !rule.lens.includes(match.national.length)) return false;
        if (rule.prefix && !rule.prefix.test(match.national)) return false;
      }
    }
    return true;
  }

  /* Specific reason a phone number is invalid — fed into the error
     message so the user knows whether they typed too few digits, too
     many, or something the country rules don't recognise. Returns
     "" if the number is valid, otherwise a short human-readable hint. */
  function phoneErrorReason(rawInput) {
    const trimmed = (rawInput || "").trim();
    if (!trimmed) return "";   // empty handled separately
    const { e164 } = toE164(trimmed);
    if (!e164 || !e164.startsWith("+")) return "We can't read that as a phone number — try including the country code.";
    const digits = e164.slice(1);
    if (digits.length < 7) return "That's too short for a phone number.";
    if (digits.length > 15) return "That's longer than any phone number should be.";

    const match = countryFromE164(e164);
    if (match) {
      const rule = PHONE_RULES[match.country];
      if (rule) {
        if (rule.lens && !rule.lens.includes(match.national.length)) {
          const expected = rule.lens.join(" or ");
          return `${match.country} numbers usually have ${expected} digits — yours has ${match.national.length}.`;
        }
        if (rule.prefix && !rule.prefix.test(match.national)) {
          return `That doesn't look like a valid ${match.country} number.`;
        }
      }
    }
    return ""; // passed all checks
  }

  /* ============================================
     Step 2 — wiring
     ============================================ */
  const form = document.getElementById("df-contactForm");
  // Alias the named inputs onto the form object so we can use the
  // concise `form.fname` syntax. Real browsers do this automatically
  // via HTMLFormElement's named properties, but JSDOM (which we use
  // for tests) doesn't, so we set them up explicitly. Using
  // form.elements.X also works everywhere; this just keeps the
  // call sites tidy.
  ["fname", "lname", "company", "email", "phone", "ext"].forEach(name => {
    if (!form[name]) form[name] = form.elements[name];
  });
  const nextBtn2 = document.getElementById("df-nextBtn2");
  const phoneConfirm = document.getElementById("df-phoneConfirm");
  const phoneE164Display = document.getElementById("df-phoneE164Display");
  const phoneCountryDisplay = document.getElementById("df-phoneCountryDisplay");
  const touched = { email: false, phone: false, ext: false, fname: false, lname: false, company: false };

  function validateEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()); }
  function validateExt(v) {
    const s = (v || "").trim();
    if (!s) return true;
    return /^[x#]?\d{1,6}$/i.test(s);
  }
  /* Company is optional. If filled, run a few light sanity checks:
     - No HTML tags (paste accidents from rich emails, also bot-bait)
     - No URLs (not a company name; usually a spammer signature)
     - Length cap (no one's company name is over 120 chars) */
  function validateCompany(v) {
    const s = (v || "").trim();
    if (!s) return true;
    if (s.length > 120) return false;
    if (/<[^>]+>/.test(s)) return false;                        // HTML
    if (/\bhttps?:\/\//i.test(s)) return false;                 // URL
    if (/[\w-]+\.(com|co|io|net|org|uk|us|ai)\b/i.test(s)) return false;
    return true;
  }

  function setFieldError(name, hasError) {
    const wrap = form.querySelector(`[data-validate="${name}"]`);
    if (wrap) wrap.classList.toggle("has-error", hasError);
  }

  function syncStateFromForm() {
    state.fname = form.fname.value.trim();
    state.lname = form.lname.value.trim();
    state.company = form.company.value.trim();
    // Email is stored lowercased — see blur handler for input mutation.
    state.email = form.email.value.trim().toLowerCase();
    state.phoneRaw = form.phone.value.trim();
    state.ext = form.ext.value.trim();
    const { e164, country } = toE164(state.phoneRaw);
    state.phoneE164 = e164;
    state.phoneCountry = country;
  }

  function refreshPhoneConfirm() {
    if (state.phoneE164 && validateE164(state.phoneE164)) {
      phoneE164Display.textContent = state.phoneE164;
      phoneCountryDisplay.textContent = "(" + state.phoneCountry + ")";
      phoneConfirm.classList.add("is-visible");
    } else {
      phoneConfirm.classList.remove("is-visible");
    }
  }

  function refreshNextButton() {
    syncStateFromForm();
    refreshPhoneConfirm();
    const ok =
      state.fname &&
      state.lname &&
      validateEmail(state.email) &&
      validateE164(state.phoneE164) &&
      validateExt(state.ext) &&
      validateCompany(state.company);
    const wasDisabled = nextBtn2.disabled;
    nextBtn2.disabled = !ok;

    // Form became invalid mid-flight → cancel any pending auto-progress.
    if (!ok) cancelAutoProgress();

    // If we just became valid AND focus is somewhere in the form (not
    // already on the button), gently move focus to the CTA. Keystroke
    // wins ("Enter to continue") then take them forward without forcing.
    // We only do this on a transition to satisfy "don't keep stealing
    // focus on every keystroke" — wasDisabled+ok is the rising edge.
    if (ok && wasDisabled) {
      const active = document.activeElement;
      const focusInForm = active && form.contains(active);
      if (focusInForm) {
        // Gentle pulse to draw the eye even when we don't move focus.
        nextBtn2.classList.add("btn-pulse");
        // Move focus only after the user has stopped typing for a
        // moment — too aggressive otherwise.
        clearTimeout(refreshNextButton._focusTimer);
        refreshNextButton._focusTimer = setTimeout(() => {
          // Re-check: state could have changed during the wait.
          if (!nextBtn2.disabled && form.contains(document.activeElement)) {
            nextBtn2.focus();
          }
        }, 600);
      }
    } else if (!ok) {
      nextBtn2.classList.remove("btn-pulse");
      clearTimeout(refreshNextButton._focusTimer);
    }
    return ok;
  }

  /* Trigger auto-progress after a blur if the form is fully valid.
     Called from each blur handler. The cancellation logic catches
     mid-edit cases — they can keep editing and the timer resets. */
  function maybeAutoProgressStep2() {
    if (state.step !== 2) return;
    if (refreshNextButton()) {
      scheduleAutoProgress(
        nextBtn2,
        document.getElementById("df-autoHint2"),
        "Continuing in a moment…"
      );
    }
  }

  // Blur: name capitalisation, email lowercasing, validation.
  form.fname.addEventListener("blur", () => {
    touched.fname = true;
    const cleaned = smartCapitalise(form.fname.value);
    if (cleaned !== form.fname.value) form.fname.value = cleaned;
    syncStateFromForm();
    maybeAutoProgressStep2();
  });
  form.lname.addEventListener("blur", () => {
    touched.lname = true;
    const cleaned = smartCapitalise(form.lname.value);
    if (cleaned !== form.lname.value) form.lname.value = cleaned;
    syncStateFromForm();
    maybeAutoProgressStep2();
  });
  form.company.addEventListener("blur", () => {
    touched.company = true;
    setFieldError("company", !validateCompany(form.company.value));
    maybeAutoProgressStep2();
  });
  form.email.addEventListener("blur", () => {
    touched.email = true;
    // Lowercase the visible value too — RFC 5321 makes the local part
    // technically case-sensitive, but in practice no real provider
    // treats it that way. Lowercasing is the standard cleaning move.
    const lower = form.email.value.trim().toLowerCase();
    if (lower !== form.email.value) form.email.value = lower;
    setFieldError("email", lower !== "" && !validateEmail(lower));
    maybeAutoProgressStep2();
  });
  /* Show the phone error with a specific reason. Pass empty string
     to clear. The reason text is updated even when hiding so we don't
     flash a stale message next time. */
  function setPhoneError(reason) {
    const wrap = form.querySelector(`[data-validate="phone"]`);
    const msgEl = document.getElementById("df-phoneErrorMsg");
    if (!wrap) return;
    if (reason) {
      msgEl.textContent = reason;
      wrap.classList.add("has-error");
    } else {
      wrap.classList.remove("has-error");
    }
  }

  form.phone.addEventListener("blur", () => {
    touched.phone = true;
    const v = form.phone.value.trim();
    if (v === "") {
      setPhoneError("");
    } else {
      setPhoneError(phoneErrorReason(v));
    }
    maybeAutoProgressStep2();
  });
  form.ext.addEventListener("blur", () => {
    touched.ext = true;
    setFieldError("ext", !validateExt(form.ext.value));
    maybeAutoProgressStep2();
  });

  /* Filter out characters that don't belong in a phone number.
     Allowed: digits, + (only first char), spaces, hyphens, parens, dots.
     Stripped on every keystroke — covers paste-from-anywhere too.
     We preserve the cursor position by counting how many characters
     before the cursor got removed. */
  function filterField(input, allowedRe, stripFn) {
    input.addEventListener("input", (e) => {
      const before = input.value;
      const cursor = input.selectionStart || 0;
      const cleaned = stripFn ? stripFn(before) : before.replace(allowedRe, "");
      if (cleaned === before) return;
      // How many characters before the cursor were removed?
      const removedBefore = before.slice(0, cursor).length - stripFn(before.slice(0, cursor)).length;
      input.value = cleaned;
      const newCursor = Math.max(0, cursor - removedBefore);
      try { input.setSelectionRange(newCursor, newCursor); } catch (e) {}
    });
  }

  // Phone: allow digits, +, spaces, -, (, ), . — strip everything else.
  // The + is only meaningful as the first character; if it appears later,
  // we silently drop it (probably a paste accident).
  filterField(form.phone, null, (s) => {
    let cleaned = s.replace(/[^\d+\-\s().]/g, "");
    // Keep at most one leading +; remove any others.
    if (cleaned.startsWith("+")) {
      cleaned = "+" + cleaned.slice(1).replace(/\+/g, "");
    } else {
      cleaned = cleaned.replace(/\+/g, "");
    }
    return cleaned;
  });

  // Extension: digits only, optionally with a leading x or # (but no
  // mid-string letters). Strip the rest as they type.
  filterField(form.ext, null, (s) => {
    if (!s) return s;
    // First character can be x, X, or #; everything after must be digits.
    const first = s[0];
    const rest = s.slice(1).replace(/\D/g, "");
    if (/[xX#]/.test(first)) return first + rest;
    return s.replace(/\D/g, "");
  });

  // Live: clear errors as user fixes them, refresh CTA.
  form.addEventListener("input", () => {
    syncStateFromForm();
    if (touched.email) {
      const v = form.email.value.trim();
      setFieldError("email", v !== "" && !validateEmail(v));
    }
    if (touched.phone) {
      const v = form.phone.value.trim();
      if (v === "") setPhoneError("");
      else setPhoneError(phoneErrorReason(v));
    }
    if (touched.ext) {
      setFieldError("ext", !validateExt(form.ext.value));
    }
    if (touched.company) {
      setFieldError("company", !validateCompany(form.company.value));
    }
    refreshNextButton();
    saveSession();   // keep the browser-side cache in sync as they type
  });

  /* Pressing Enter in any form field submits the step if everything
     is valid. Prevents the default form submission (which would reload
     the page since we're not preventing it server-side). */
  form.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!nextBtn2.disabled) nextBtn2.click();
    }
  });

  nextBtn2.addEventListener("click", () => {
    syncStateFromForm();
    touched.email = touched.phone = touched.ext = touched.company = true;
    setFieldError("email", !validateEmail(state.email));
    setPhoneError(phoneErrorReason(state.phoneRaw));
    setFieldError("ext", !validateExt(state.ext));
    setFieldError("company", !validateCompany(state.company));

    const failures = [];
    if (!validateEmail(state.email))      failures.push("email");
    if (!validateE164(state.phoneE164))   failures.push("phone");
    if (!validateExt(state.ext))          failures.push("ext");
    if (!validateCompany(state.company))  failures.push("company");
    if (failures.length) {
      LOG.warn("form", "submit_blocked_by_validation", { failures });
      return;
    }
    if (!passesBotChecks()) return;

    LOG.log("form", "step2_submitted", {
      project: state.project,
      hasCompany: !!state.company,
      phoneCountry: state.phoneCountry,
      hasExt: !!state.ext,
    });
    persist("contact_captured", {
      fname: state.fname, lname: state.lname,
      company: state.company,
      email: state.email,
      phoneRaw: state.phoneRaw,
      phoneE164: state.phoneE164,
      phoneCountry: state.phoneCountry,
      ext: state.ext,
      project: state.project,
    });
    setStep(3);
    renderCalendar();
    refreshTalkOptions();          // tailor the dial number to their country
    checkCallbackAvailability();   // check if call-me-now is live right now
    startAvailabilityPolling();    // …and keep it fresh while they're on this step
  });

  /* ============================================
     Step 3 — calendar
     ============================================ */
  const monthLabel = document.getElementById("df-calMonth");
  const dayGrid = document.getElementById("df-dayGrid");
  const slotsGrid = document.getElementById("df-slotsGrid");
  const slotDayLabel = document.getElementById("df-slotDayLabel");
  const tzChip = document.getElementById("df-tzChip");
  const tzChipLabel = document.getElementById("df-tzChipLabel");
  const tzPopover = document.getElementById("df-tzPopover");
  const prevMonthBtn = document.getElementById("df-prevMonth");
  const nextMonthBtn = document.getElementById("df-nextMonth");
  const nextBtn3 = document.getElementById("df-nextBtn3");

  /* Detected browser timezone — the IANA identifier ("Europe/London"). */
  const browserTimezone = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
    catch (e) { return "UTC"; }
  })();

  /* Curated list of common business zones. Their detected zone is
     surfaced separately at the top so it's never lost in the list. */
  const COMMON_TIMEZONES = [
    "Europe/London", "Europe/Dublin",
    "Europe/Paris", "Europe/Berlin", "Europe/Amsterdam", "Europe/Madrid",
    "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
    "America/Toronto", "America/Sao_Paulo",
    "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Hong_Kong",
    "Asia/Tokyo", "Asia/Seoul",
    "Australia/Sydney", "Australia/Melbourne",
    "Pacific/Auckland",
    "UTC",
  ];

  /* Display label for an IANA TZ — strips the prefix ("Europe/")
     and replaces underscores. Used in the chip and popover rows. */
  function tzLabel(tz) {
    if (!tz) return "—";
    const parts = tz.split("/");
    return parts[parts.length - 1].replace(/_/g, " ");
  }

  /* Compute the UTC offset for a TZ on a given date, formatted like
     "+01:00" or "-08:00". Used as a hint in the popover so users can
     orient themselves quickly. */
  function tzOffset(tz, date = new Date()) {
    try {
      const dtf = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz, hour: "2-digit", minute: "2-digit", timeZoneName: "shortOffset",
      });
      const parts = dtf.formatToParts(date);
      const off = parts.find(p => p.type === "timeZoneName");
      if (!off) return "";
      // Browser returns things like "GMT+1", "GMT-08:00". Normalise.
      const m = off.value.match(/GMT([+-]?\d+)(?::(\d+))?/);
      if (!m) return off.value;
      const hh = String(parseInt(m[1], 10)).padStart(m[1].startsWith("-") ? 3 : 2, "0").replace(/^(-?)0?/, "$1");
      const sign = m[1].startsWith("-") ? "-" : "+";
      const hours = String(Math.abs(parseInt(m[1], 10))).padStart(2, "0");
      const mins = (m[2] || "00").padStart(2, "0");
      return `${sign}${hours}:${mins}`;
    } catch (e) { return ""; }
  }

  /* Active timezone — the user's choice if they've set one, otherwise
     the browser's IANA TZ. */
  function activeTimezone() {
    return state.selectedTimezone || browserTimezone;
  }

  function refreshTzChip() {
    tzChipLabel.textContent = tzLabel(activeTimezone());
  }

  /* Build the popover. Detected zone first (highlighted), then the
     curated list, deduped. Each row shows label + GMT offset. */
  function buildTzPopover() {
    tzPopover.innerHTML = "";
    const seen = new Set();
    const rows = [];

    // Detected first.
    rows.push({ tz: browserTimezone, label: tzLabel(browserTimezone) + " (detected)", isCurrent: activeTimezone() === browserTimezone });
    seen.add(browserTimezone);

    for (const tz of COMMON_TIMEZONES) {
      if (seen.has(tz)) continue;
      rows.push({ tz, label: tzLabel(tz), isCurrent: activeTimezone() === tz });
      seen.add(tz);
    }

    rows.forEach(({ tz, label, isCurrent }) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "tz-popover-row" + (isCurrent ? " is-current" : "");
      row.innerHTML = `<span>${label}</span><span class="tz-offset">${tzOffset(tz)}</span>`;
      row.addEventListener("click", () => {
        state.selectedTimezone = tz;
        saveSession();
        refreshTzChip();
        tzPopover.hidden = true;
        LOG.log("calendar", "timezone_changed", { from: browserTimezone, to: tz });
      });
      tzPopover.appendChild(row);
    });
  }

  tzChip.addEventListener("click", () => {
    if (tzPopover.hidden) {
      buildTzPopover();
      tzPopover.hidden = false;
    } else {
      tzPopover.hidden = true;
    }
  });
  // Click outside closes.
  document.addEventListener("click", (e) => {
    if (!tzPopover.hidden && !tzPopover.contains(e.target) && e.target !== tzChip && !tzChip.contains(e.target)) {
      tzPopover.hidden = true;
    }
  });

  function slotsFor(date) {
    const dow = date.getDay();
    if (dow === 0 || dow === 6) return [];
    const base = ["09:30", "10:30", "11:30", "14:00", "15:00", "16:00"];
    if (dow === 1) return base.slice(1);
    if (dow === 5) return base.slice(0, 4);
    return base;
  }

  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function sameDay(a, b) {
    return a && b && a.getFullYear() === b.getFullYear()
        && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  function fmtMonth(d) { return d.toLocaleDateString("en-GB", { month: "long", year: "numeric" }); }
  function fmtDayLabel(d) { return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }); }

  function renderCalendar() {
    if (!state.calMonth) state.calMonth = startOfMonth(new Date());
    const month = state.calMonth;
    monthLabel.textContent = fmtMonth(month);

    const todayMonth = startOfMonth(new Date());
    prevMonthBtn.disabled = month <= todayMonth;

    const firstWeekday = (month.getDay() + 6) % 7;
    const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const horizon = new Date(today); horizon.setDate(horizon.getDate() + 21);

    dayGrid.innerHTML = "";
    for (let i = 0; i < firstWeekday; i++) dayGrid.appendChild(document.createElement("div"));
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(month.getFullYear(), month.getMonth(), day);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "day";
      btn.textContent = day;
      const slots = slotsFor(date);
      const inWindow = date >= today && date <= horizon;
      const available = inWindow && slots.length > 0;
      if (!available) btn.disabled = true;
      else btn.classList.add("has-slots");
      if (sameDay(state.selectedDate, date)) btn.classList.add("selected");
      btn.addEventListener("click", () => {
        state.selectedDate = date;
        state.selectedSlot = null;
        nextBtn3.disabled = true;
        saveSession();
        LOG.log("calendar", "date_selected", { date: date.toISOString().slice(0,10) });
        renderCalendar();
        renderSlots();
      });
      dayGrid.appendChild(btn);
    }

    refreshTzChip();
    renderSlots();
  }

  function renderSlots() {
    if (!state.selectedDate) {
      slotDayLabel.textContent = "—";
      slotsGrid.innerHTML = '<div class="slots-empty">Pick a date above.</div>';
      return;
    }
    slotDayLabel.textContent = fmtDayLabel(state.selectedDate);
    const slots = slotsFor(state.selectedDate);
    slotsGrid.innerHTML = "";
    slots.forEach(t => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "slot" + (state.selectedSlot === t ? " selected" : "");
      b.textContent = t;
      b.addEventListener("click", () => {
        state.selectedSlot = t;
        nextBtn3.disabled = false;
        saveSession();
        LOG.log("calendar", "slot_selected", {
          date: state.selectedDate.toISOString().slice(0,10),
          slot: t,
          timezone: state.selectedTimezone || browserTimezone,
        });
        renderSlots();
      });
      slotsGrid.appendChild(b);
    });
  }

  prevMonthBtn.addEventListener("click", () => {
    const m = state.calMonth;
    const prev = new Date(m.getFullYear(), m.getMonth() - 1, 1);
    if (prev >= startOfMonth(new Date())) {
      state.calMonth = prev;
      renderCalendar();
    }
  });
  nextMonthBtn.addEventListener("click", () => {
    const m = state.calMonth;
    state.calMonth = new Date(m.getFullYear(), m.getMonth() + 1, 1);
    renderCalendar();
  });

  nextBtn3.addEventListener("click", () => {
    if (!state.selectedDate || !state.selectedSlot) return;
    LOG.log("calendar", "meeting_confirmed", {
      date: state.selectedDate.toISOString().slice(0, 10),
      slot: state.selectedSlot,
      timezone: activeTimezone(),
      project: state.project,
    });
    persist("meeting_booked", {
      project: state.project,
      date: state.selectedDate.toISOString().slice(0, 10),
      slot: state.selectedSlot,
      timezone: activeTimezone(),
      fname: state.fname, lname: state.lname,
      company: state.company,
      email: state.email,
      phoneRaw: state.phoneRaw,
      phoneE164: state.phoneE164,
      phoneCountry: state.phoneCountry,
      ext: state.ext,
    });
    hydrateConfirmation();
    setStep(4);
  });

  /* ============================================
     Step 3 — call-back & dial-us handling
     ============================================
     Two paths to talk to us right now:

     1) "Call me now" → POSTs directly to the c2c widget's REST API on
        connect.doorflow.com (same endpoints the floating widget uses).
        We have name + phone + email + company by step 3, so we can
        bypass the widget UI entirely and show our own confirmation
        instead. The API exposes:

          POST /api/v1/call                       → initiate
          GET  /api/v1/call_requests/{id}/status  → poll
          POST /api/v1/call_requests/{id}/cancel  → user cancels
          GET  /api/v1/widgets/{widgetId}         → status (+ availability)

        Phone format the API expects: prefix + national digits with
        leading zeros stripped, e.g. "+447911123456". Our state.phoneE164
        is already in that exact form.

     2) "Dial us directly" → tel: link, region-aware. If the lead's
        phone number is +1 (US/CA), we surface the US support line; for
        everyone else, the GB number. */

  const C2C_HOST     = "https://connect.doorflow.com";
  const C2C_WIDGET   = "LB5CKv";
  const POLL_EVERY   = 1500;     // ms — matches widget.js
  const POLL_MAX     = 500;      // safety ceiling, also from widget.js

  // Support numbers — replace these with your real numbers in production.
  const SUPPORT_NUMBERS = {
    GB: { e164: "+442038852345", display: "+44 (0) 20 3885 2345", hours: "Mon–Fri, 9–5 GMT" },
    US: { e164: "+16502620333",  display: "+1 (650) 262 0333",    hours: "Mon–Fri, 9–5 PT" },
  };

  function pickSupportRegion() {
    return (state.phoneE164 || "").startsWith("+1") ? "US" : "GB";
  }

  /* ---------------------------------------------
     Server-time workaround
     ---------------------------------------------
     TODO(server-time): the connect.doorflow.com widget endpoint
     returns availability timestamps with a "Z" suffix (suggesting
     UTC) but the values are actually configured as UK wall-clock
     times — i.e. when the server says "2026-05-07T18:00:00Z", it
     really means 18:00 Europe/London local, not 18:00 UTC. This
     should be fixed on the server side: either return real UTC
     timestamps, or include an explicit timezone identifier.

     Until then we compensate client-side with parseAsUkTime() and
     fmtServerTime(). When the server is fixed:
       1. delete parseAsUkTime, ukOffsetMinutesAt, fmtServerTime
       2. replace fmtServerTime(callbackNextOpen) calls with
          new Date(callbackNextOpen).toLocaleString(...)
       3. update the closed-state display in refreshCallbackButton
          to use plain new Date() too
       4. remove this TODO and the related test in tests.mjs
          (parseAsUkTime suite)

     parseAsUkTime(): take the wall-clock components from an ISO
     string and reinterpret them as Europe/London local. Returns a
     Date pointing to the correct UTC instant for that UK wall time.

     fmtServerTime(): format a server-provided "Z" timestamp for
     human display, treating the components as UK-local (so 18:00Z
     displays as 18:00 / 6pm). */
  function parseAsUkTime(serverIso) {
    if (!serverIso) return null;
    // Strip any zone designator — we treat the wall-clock components
    // as UK-local regardless of what the server claims. A Z, a +HH:MM,
    // or no suffix all get the same treatment.
    const wallClock = String(serverIso).replace(/(Z|[+-]\d{2}:?\d{2})$/, "");
    // Naive parse — treats the string as UTC due to JS's ISO behaviour
    // when no zone is present. We then offset by however much UK is
    // ahead of UTC at that wall-clock moment (1h during BST, 0h in
    // GMT). Computing this from the date itself is mildly tricky
    // because the offset depends on the date — we use Intl to ask.
    const naive = new Date(wallClock + "Z");
    if (isNaN(naive)) return null;
    // Find UK's offset for that calendar moment.
    const ukOffsetMin = ukOffsetMinutesAt(naive);
    return new Date(naive.getTime() - ukOffsetMin * 60_000);
  }
  function ukOffsetMinutesAt(date) {
    // Returns positive minutes for offsets ahead of UTC (so BST = 60).
    // Uses Intl.DateTimeFormat to format the date in Europe/London and
    // diffs it from the same moment formatted as UTC. The shortOffset
    // formatter gives strings like "GMT+1" / "GMT" we can parse, but
    // diff-via-format is more robust against locale quirks.
    const dtf = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    });
    const parts = dtf.formatToParts(date).reduce((acc, p) => {
      if (p.type !== "literal") acc[p.type] = p.value;
      return acc;
    }, {});
    // Reconstruct a UTC date from those wall-clock parts and diff.
    const ukAsUtc = Date.UTC(
      parseInt(parts.year), parseInt(parts.month) - 1, parseInt(parts.day),
      parseInt(parts.hour) === 24 ? 0 : parseInt(parts.hour),
      parseInt(parts.minute), parseInt(parts.second)
    );
    return Math.round((ukAsUtc - date.getTime()) / 60_000);
  }
  function fmtServerTime(serverIso, opts) {
    const d = parseAsUkTime(serverIso);
    if (!d) return "";
    return d.toLocaleString("en-GB", { timeZone: "Europe/London", ...(opts || {}) });
  }

  function refreshTalkOptions() {
    const region = pickSupportRegion();
    const support = SUPPORT_NUMBERS[region];
    const dialBtn = document.getElementById("df-dialUsBtn");
    const dialDesc = document.getElementById("df-dialUsDesc");
    if (dialBtn) dialBtn.href = "tel:" + support.e164;
    if (dialDesc) dialDesc.textContent = support.display + " · " + support.hours;
  }

  /* Check if the call-me-now option should be live, based on the
     widget's reported availability. The widget endpoint returns:
       { status: { active: bool, available: bool, time: ISO } }
     where `time` is when lines next open if currently closed. */
  let callbackAvailable = null;   // null = unknown, true = open, false = closed
  let callbackNextOpen = null;
  let availabilityPollHandle = null;
  let closedStateTickHandle = null;
  let boundaryPollHandle = null;

  /* How often we re-check availability while step 3 is visible. The
     widget config could change at any time on the connect.doorflow.com
     side (someone toggles it off, lines genuinely close, etc.) and
     we want the UI to follow within a reasonable window. Set tight
     during testing — relax to 60_000+ once it's known to be working. */
  const AVAILABILITY_POLL_MS = 30_000;

  async function checkCallbackAvailability() {
    LOG.log("call", "availability_check", { widgetId: C2C_WIDGET });
    try {
      const res = await fetch(`${C2C_HOST}/api/v1/widgets/${C2C_WIDGET}`);
      if (!res.ok) throw new Error("Widget status fetch failed: " + res.status);
      const data = await res.json();
      const status = data.status || {};
      callbackAvailable = !!(status.active && status.available);
      callbackNextOpen = status.time || null;
      // Log the FULL status payload alongside the local time
      // interpretation so we can diagnose timezone issues. If the
      // server returns a UTC time but is configured assuming GMT (no
      // BST adjustment), this is where it'll be visible.
      LOG.log("call", "availability_resolved", {
        active: !!status.active,
        available: !!status.available,
        nextOpen: callbackNextOpen,
        // Interpret server's "Z" suffix as UK-local (server bug
        // workaround — see parseAsUkTime). Once the server is fixed,
        // switch back to `new Date(callbackNextOpen).toLocaleString(...)`.
        nextOpenLocal: callbackNextOpen ? fmtServerTime(callbackNextOpen) : null,
        nowLocal: new Date().toLocaleString("en-GB", { timeZone: "Europe/London" }),
        nowUtc: new Date().toISOString(),
        rawStatus: status,
      });
    } catch (e) {
      // If we can't reach the API, assume callable rather than blocking.
      // Worst case the API call below fails and we fall back to the widget.
      LOG.warn("call", "availability_check_failed", { error: String(e), assumingAvailable: true });
      callbackAvailable = true;
    }
    refreshCallbackButton();
    // Reschedule the precise boundary poll in case nextOpen has
    // changed in this response. Safe to call when polling isn't
    // active — it's a no-op then.
    if (typeof scheduleBoundaryPoll === "function") scheduleBoundaryPoll();
  }

  /* Periodic re-check loop. Runs while:
       - we're on step 3
       - the page is visible (no point polling if the user has
         backgrounded the tab)
       - no call is currently in flight (would be redundant during
         a call and we don't want to flicker the button state)
     Started by startAvailabilityPolling(), stopped by stop. The
     interval is configurable via AVAILABILITY_POLL_MS above. */
  function startAvailabilityPolling() {
    stopAvailabilityPolling();
    if (typeof document !== "undefined" && document.hidden) return;
    availabilityPollHandle = setInterval(() => {
      // Skip if we've left step 3, the tab's hidden, or we're mid-call.
      if (state.step !== 3) { stopAvailabilityPolling(); return; }
      if (document.hidden) return;     // pause but don't stop
      if (activeCallRequestId) return; // pause during in-flight call
      checkCallbackAvailability();
    }, AVAILABILITY_POLL_MS);
    LOG.log("call", "availability_polling_started", { intervalMs: AVAILABILITY_POLL_MS });
    // Separate clock tick. The user expects the UI to flip the moment
    // lines open or close, not whenever the next 30s server poll
    // happens to fire. So this tick re-renders the closed state so
    // messaging transitions smoothly between buckets ("Next open at
    // 10:30" → "Opening soon").
    if (closedStateTickHandle) clearInterval(closedStateTickHandle);
    closedStateTickHandle = setInterval(() => {
      if (state.step !== 3) return;
      if (activeCallRequestId) return;

      const el = document.getElementById("df-callNowBtn");
      // Re-render closed state for graded message buckets.
      if (el && el.dataset.state === "closed") refreshCallbackButton();
      // Also re-render ready when we're showing closing-soon — the
      // countdown text needs to track the clock.
      if (el && el.dataset.state === "ready" && callbackAvailable === true) {
        refreshCallbackButton();
      }
    }, 15_000);

    // Schedule a precise one-shot poll at the next announced boundary.
    // This is what makes the UI tick to available/closed *the second*
    // the announced moment elapses — independent of the 30s scheduled
    // poll. We add a small grace (1s) so the server has a beat to
    // catch up; the grade-by-time logic in refreshCallbackButton
    // covers the case where the server's still lagging.
    scheduleBoundaryPoll();
  }
  function scheduleBoundaryPoll() {
    if (boundaryPollHandle) {
      clearTimeout(boundaryPollHandle);
      boundaryPollHandle = null;
    }
    if (!callbackNextOpen) return;
    const t = parseAsUkTime(callbackNextOpen);
    if (!t) return;
    const msUntil = t.getTime() - Date.now() + 1000; // +1s grace
    if (msUntil <= 0) return; // boundary's in the past; the next poll will catch up
    LOG.log("call", "boundary_poll_scheduled", { atIso: t.toISOString(), inMs: msUntil });
    boundaryPollHandle = setTimeout(() => {
      boundaryPollHandle = null;
      if (state.step !== 3) return;
      if (activeCallRequestId) return;
      LOG.log("call", "boundary_reached_immediate_poll", {});
      checkCallbackAvailability();
    }, msUntil);
  }
  function stopAvailabilityPolling() {
    if (availabilityPollHandle) {
      clearInterval(availabilityPollHandle);
      availabilityPollHandle = null;
      LOG.log("call", "availability_polling_stopped", {});
    }
    if (closedStateTickHandle) {
      clearInterval(closedStateTickHandle);
      closedStateTickHandle = null;
    }
    if (boundaryPollHandle) {
      clearTimeout(boundaryPollHandle);
      boundaryPollHandle = null;
    }
  }

  /* When the tab becomes visible again after being hidden, re-check
     availability immediately (don't wait up to AVAILABILITY_POLL_MS).
     This catches the "I came back from another tab and the lines just
     opened" case nicely. */
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && state.step === 3 && !activeCallRequestId) {
        LOG.log("call", "visibility_resumed", {});
        checkCallbackAvailability();
      }
    });
  }

  /* Refresh the "Call me now" element. Two non-active states ride
     here (ready / closed). Active states are set by the call handlers
     directly via setCallOptionState().

     forceReset: when true, bypass the "don't stomp on an active call"
     guard. Used by the close/retry/another handlers — they're
     deliberately leaving an active state and want a clean slate. */
  function refreshCallbackButton(forceReset) {
    const el = document.getElementById("df-callNowBtn");
    const title = document.getElementById("df-callNowTitle");
    const desc = document.getElementById("df-callNowDesc");
    if (!el) return;

    // Don't stomp on an active call — leave it alone (unless the
    // caller explicitly asked for a reset).
    const active = ["dialling", "ringing", "connected", "cancelled", "failed", "completed"];
    if (!forceReset && active.includes(el.dataset.state)) return;

    if (callbackAvailable === false) {
      // Server says closed → we say closed. No second-guessing the
      // server's data here; if the user thinks lines should be open
      // and we let them try anyway, the call API just rejects with
      // "Widget is not available" which is a worse experience than
      // a clear "closed" message. The graded buckets below are just
      // about *how* we say closed, not whether.
      el.dataset.state = "closed";
      el.setAttribute("aria-disabled", "true");
      el.removeAttribute("tabindex");

      const nextOpenDate = callbackNextOpen ? parseAsUkTime(callbackNextOpen) : null;
      const minsUntilOpen = nextOpenDate ? (nextOpenDate.getTime() - Date.now()) / 60_000 : null;

      let titleText = "Lines are closed right now";
      let when = "You can still book a meeting above.";

      if (nextOpenDate && minsUntilOpen !== null && minsUntilOpen > 0) {
        const time = nextOpenDate.toLocaleTimeString("en-GB", {
          hour: "numeric", minute: "2-digit", timeZone: "Europe/London",
        });
        if (minsUntilOpen <= 5) {
          // Within 5 minutes — warmer tone, give them confidence.
          titleText = "Opening soon";
          when = `Lines open at ${time}.`;
        } else {
          // Genuine future open time — formal scheduled message.
          const day = nextOpenDate.toLocaleDateString("en-GB", {
            weekday: "long", timeZone: "Europe/London",
          });
          const today = new Date().toLocaleDateString("en-GB", {
            weekday: "long", timeZone: "Europe/London",
          });
          when = day === today
            ? `Next open at ${time}.`
            : `Next open at ${time} on ${day}.`;
        }
      }
      // If nextOpen is in the past but the server still says closed,
      // we just leave the default "Lines are closed right now" / "You
      // can still book a meeting above." — honest, accurate, no lying.
      title.textContent = titleText;
      desc.textContent = when;
    } else {
      el.dataset.state = "ready";
      el.removeAttribute("aria-disabled");
      el.setAttribute("tabindex", "0");

      // While available, the server's `time` field (if present) is
      // the next-close time. Use it to surface a "closing soon" hint
      // when we're within 5 minutes of cut-off. This stops a user
      // placing a call right before lines close. If the field isn't
      // present we just skip the hint.
      // TODO: handle the extension number too. Once we ring the user
      // and they pick up, we should make it easy for them to know
      // their entered extension is being used. For now we just dial
      // the main number and the c2c side reads the extension from
      // the call payload. The display copy below could include
      // "ext. 123" if state.ext is set.
      const nextCloseDate = callbackNextOpen ? parseAsUkTime(callbackNextOpen) : null;
      const minsUntilClose = nextCloseDate ? (nextCloseDate.getTime() - Date.now()) / 60_000 : null;
      const closingSoon = minsUntilClose !== null && minsUntilClose > 0 && minsUntilClose <= 5;

      if (closingSoon) {
        const closeTime = nextCloseDate.toLocaleTimeString("en-GB", {
          hour: "numeric", minute: "2-digit", timeZone: "Europe/London",
        });
        title.textContent = "Closing soon";
        desc.innerHTML = state.phoneE164 && validateE164(state.phoneE164)
          ? `We'll ring <strong>${state.phoneE164}</strong> now — lines close at ${closeTime}.`
          : `We'll ring your number now — lines close at ${closeTime}.`;
      } else {
        title.textContent = "Call me now";
        desc.innerHTML = state.phoneE164 && validateE164(state.phoneE164)
          ? `We'll ring <strong>${state.phoneE164}</strong> in about 30 seconds.`
          : "We'll ring your number in about 30 seconds.";
      }
    }
  }

  /* Submit call-back. Returns the call_request id on success or
     throws (with the API's own error list joined into the message). */
  async function initiateCallBack({ first_name, last_name, company, user_phone }) {
    LOG.log("call", "request_sent", {
      endpoint: `${C2C_HOST}/api/v1/call`,
      widget_id: C2C_WIDGET,
      first_name, last_name, company, user_phone,
    });
    const res = await fetch(`${C2C_HOST}/api/v1/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        widget_id: C2C_WIDGET,
        first_name, last_name, company, user_phone,
      }),
    });
    const data = await res.json().catch(() => null);

    LOG.log("call", "request_response", {
      httpStatus: res.status,
      ok: res.ok,
      body: data,
    });

    // The API uses two error shapes depending on the failure type:
    //   - 200 with { errors: [...] }       — validation failures
    //   - non-200 with { error: "..." } or { errors: [...] }  — auth / server errors
    // We try every plausible shape and surface the most informative
    // string we can find. Falling back to "HTTP 403" etc. is still
    // more useful than a generic "We couldn't place the call".
    if (!res.ok) {
      const detail =
        (data && (data.error || (data.errors && data.errors.join(", ")))) ||
        `HTTP ${res.status}`;
      throw new Error(detail);
    }
    if (data && data.errors && data.errors.length) {
      throw new Error(data.errors.join(", "));
    }
    if (!data || !data.id) {
      throw new Error("Unexpected response from call API");
    }
    LOG.log("call", "request_accepted", { callRequestId: data.id });
    return data.id;
  }

  async function fetchCallStatus(callRequestId) {
    const res = await fetch(`${C2C_HOST}/api/v1/call_requests/${callRequestId}/status`);
    if (!res.ok) throw new Error("Status fetch failed: " + res.status);
    return res.json();
  }

  async function cancelCallRequest(callRequestId) {
    const res = await fetch(`${C2C_HOST}/api/v1/call_requests/${callRequestId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
    });
    return res.json().catch(() => ({}));
  }

  /* ============================================
     Call-option state machine
     ============================================
     setCallOptionState() is the single function that mutates the
     "Call me now" element for active call states. It updates the
     data-state attribute, title, description, and toggles which
     inline action links are visible. The element is *the* UI for
     the call — there is no separate pill. */
  let activePollHandle = null;
  let activeCallRequestId = null;
  // After a successful call completes, the panel sits in the "Call
  // ended" state showing a tick. We give it 10 seconds to be visible
  // (so the user registers the success), then auto-revert to the
  // ready state so a follow-up call doesn't need an explicit click
  // on "Place another call". Cancelled if anything else changes the
  // pill state in the meantime.
  let completedAutoResetHandle = null;
  const COMPLETED_AUTO_RESET_MS = 10_000;

  // Lifecycle timings for the active call. Used purely for logging
  // right now — they let us see at terminal time how long each phase
  // lasted (request → first-connected → completed), which helps
  // diagnose calls that ended unusually fast (e.g. agent hung up
  // without a real conversation).
  //
  // TODO(brief-call-detection): once we know what fields the c2c
  // `call_request` payload exposes, replace this purely-client-side
  // timing with whatever the server tells us authoritatively. Until
  // then, connected-phase duration is a useful heuristic — anything
  // under ~10 seconds of "Call connected" before "Call completed"
  // is likely a dropped/aborted call rather than a real conversation,
  // and we could surface that with gentler copy ("Call ended early
  // — try again?") instead of the celebratory "Thanks for the chat".
  let callTimings = null;
  function resetCallTimings() {
    callTimings = {
      requestedAt: null,         // ms — when we POSTed /call
      firstConnectedAt: null,    // ms — first poll showing "Call connected"
      terminalAt: null,          // ms — first terminal poll
    };
  }
  resetCallTimings();

  function stopPolling() {
    if (activePollHandle) {
      clearTimeout(activePollHandle);
      activePollHandle = null;
    }
  }

  function setCallOptionState({ state: pillState, title, desc, actions }) {
    const el = document.getElementById("df-callNowBtn");
    if (!el) return;
    el.dataset.state = pillState;
    el.setAttribute("aria-disabled", "true");   // not clickable in active states
    el.removeAttribute("tabindex");
    document.getElementById("df-callNowTitle").textContent = title || "";
    document.getElementById("df-callNowDesc").innerHTML = desc || "";
    const set = new Set(actions || []);
    document.getElementById("df-cancelCallBtn").hidden = !set.has("cancel");
    document.getElementById("df-closeCallBtn").hidden  = !set.has("close");
    document.getElementById("df-retryCallBtn").hidden  = !set.has("retry");
    document.getElementById("df-anotherCallBtn").hidden = !set.has("another");
    document.getElementById("df-openWidgetBtn").hidden = !set.has("widget");
  }

  /* Status string → visual state. Cancellable + not connected = ringing
     (means the API has someone on the other end and we're trying to
     bridge). Otherwise dialling. */
  function statusToCallState(rawStatus, cancellable, connected) {
    if (connected) return "connected";
    return cancellable ? "ringing" : "dialling";
  }

  /* Classify a status string into a terminal outcome. The API doesn't
     give us a clean enum — just human-readable strings like "Call
     connected", "Sales declined", "Going to voicemail" — so we do
     keyword matching. The classifications drive the UI state when
     polling has ended (continue_polling: false).

     Returns one of:
       "success"   — call landed (live person OR voicemail counts)
       "declined"  — sales side rejected
       "no_answer" — nobody picked up
       "busy"      — engaged
       "unknown"   — we don't recognise the string */
  function classifyTerminalStatus(statusStr) {
    const s = (statusStr || "").toLowerCase();
    // "Call completed" is what we get after a successful call ends —
    // distinct from "Call connected" which fires while still in
    // progress. Treat it as a separate terminal so the UI can
    // celebrate rather than cross-icon it.
    if (s.includes("completed") || s.includes("call ended")) return "completed";
    if (s.includes("connected"))    return "success";
    // Voicemail variants — both explicit ("voicemail", "answerphone")
    // and the indirect language the API sometimes uses ("leave us a
    // message", "leave a message"). The latter caught us out in
    // production once when a call routed straight to voicemail with
    // a status like "We can't take your call at the moment. We'll
    // call you now so that you can leave us a message."
    if (s.includes("voicemail") || s.includes("answerphone") || s.includes("answer machine")) return "success";
    if (s.includes("leave us a message") || s.includes("leave a message"))  return "success";
    if (s.includes("declined") || s.includes("rejected"))  return "declined";
    if (s.includes("no answer") || s.includes("unanswered") || s.includes("no-one"))  return "no_answer";
    if (s.includes("busy") || s.includes("engaged"))       return "busy";
    if (s.includes("cancelled"))    return "declined";   // user-initiated cancel comes via the cancel button, but defensive
    return "unknown";
  }

  async function pollLoop(callRequestId, attempt = 0) {
    if (attempt >= POLL_MAX) {
      LOG.error("call", "poll_max_reached", { callRequestId, attempts: attempt });
      setCallOptionState({
        state: "failed",
        title: "Call request timed out",
        desc: "Sorry — please try again, or book a slot above.",
        actions: ["retry", "close"],
      });
      return;
    }
    try {
      const data = await fetchCallStatus(callRequestId);
      // Track first-time-we-saw-connected so we can later compute how
      // long the connected phase lasted. Useful for spotting calls
      // that ended unusually fast (likely dropped). See the
      // TODO(brief-call-detection) note where callTimings is declared.
      if (data.status === "Call connected" && callTimings && !callTimings.firstConnectedAt) {
        callTimings.firstConnectedAt = Date.now();
        LOG.log("call", "phase_connected_started", {
          callRequestId,
          msSinceRequest: callTimings.requestedAt
            ? Date.now() - callTimings.requestedAt
            : null,
        });
      }
      // Surface the per-leg Twilio statuses as top-level fields so
      // they're skimmable in the console without expanding nested
      // objects. The c2c controller squashes both into the human
      // status string but the underlying truth is in the two leg
      // statuses — that's where we can see e.g. "agent leg is
      // in-progress but user leg is requested" (i.e. agent answered
      // but we haven't dialled the user yet).
      //
      // From inspecting the c2c controller's call_request_status
      // logic, the leg statuses follow Twilio's call lifecycle:
      //   sales_status: requested → initiated → ringing → in-progress
      //                          → completed | no-answer | busy | failed | canceled
      //   user_status:  same vocabulary, plus "answered" in some paths
      //
      // The squashed status string is:
      //   "Notifying agent ..."  while sales_status is in-progress/initiated/ringing
      //   "Calling you now ..."  when sales_status confirmed OR user_status ringing
      //   "Call connected"       when user_status answered, OR both legs in-progress
      //   "Call completed"       when user_status completed
      //   voicemail message      when sales_status is unavailable/no-answer/busy
      //
      // TODO(twilio-leg-truth): the "both legs in-progress" path to
      // "Call connected" is unreliable — Twilio reports in-progress
      // for the dial action, not necessarily user pickup. We've seen
      // sessions where the agent's line auto-answered (voicemail
      // forking?) and the user-side dial appeared to progress without
      // the user's phone actually ringing. The c2c team could improve
      // this by only declaring "Call connected" when the user-side
      // <Dial> action's child call confirms answered audio, not just
      // in-progress state.
      const cr = data.call_request || {};
      LOG.log("call", `poll_${attempt + 1}`, {
        callRequestId,
        attempt: attempt + 1,
        status: data.status,
        sales_status: cr.sales_status || null,
        user_status: cr.user_status || null,
        cancellable: data.cancellable,
        continue_polling: data.continue_polling,
        call_request: data.call_request || null,
        full: data,
      });

      const status = data.status || "Working on it…";
      const cancellable = !!data.cancellable;
      const connected = status === "Call connected";
      const continuing = !!data.continue_polling;

      // Terminal handling: if the API tells us not to keep polling,
      // transition to a settled state regardless of what the status
      // string is. Otherwise render the in-flight state.
      if (!continuing) {
        const outcome = classifyTerminalStatus(status);
        // Compute lifecycle durations for this call.
        if (callTimings) callTimings.terminalAt = Date.now();
        const totalMs = callTimings && callTimings.requestedAt
          ? callTimings.terminalAt - callTimings.requestedAt
          : null;
        const connectedMs = callTimings && callTimings.firstConnectedAt
          ? callTimings.terminalAt - callTimings.firstConnectedAt
          : null;
        const cr2 = data.call_request || {};
        LOG.log("call", "poll_terminal", {
          callRequestId,
          finalStatus: status,
          classified: outcome,
          // Final per-leg statuses — most diagnostic for call outcomes.
          // E.g. sales_status:"no-answer" → agent never picked up;
          // sales_status:"completed", user_status:"completed" with
          // a long connectedMs → real conversation.
          sales_status: cr2.sales_status || null,
          user_status: cr2.user_status || null,
          totalPolls: attempt + 1,
          totalMs,
          connectedMs,                  // null if we never reached "Call connected"
          // Echo the call_request payload at terminal time too — it's
          // most likely to contain final details (duration, end reason)
          // here vs on intermediate polls.
          call_request: data.call_request || null,
          full: data,
        });
        if (outcome === "completed") {
          // Successful call ended normally. Tick icon, friendly close,
          // option to start a new call. No "Try again" — there's
          // nothing to retry; the call worked.
          //
          // TODO(brief-call-detection): once we have a reliable signal
          // for whether a call was a real conversation vs a dropped
          // /aborted attempt, branch the copy here. Likely options:
          //   - very short (e.g. <10s connectedMs): "Call ended early.
          //     If that was a mistake, you can place another call now."
          //     with actions: ["another", "retry"] — retry kicks off
          //     a new attempt without an explicit click.
          //   - normal duration: current celebratory copy.
          // We'd ideally key off a server field (call_request.end_reason
          // or duration_seconds), falling back to our locally-computed
          // connectedMs if the server doesn't provide one.
          setCallOptionState({
            state: "completed",
            title: "Call ended",
            desc: "Thanks for the chat — hope that was useful. We'll log everything for follow-up.",
            actions: ["another"],
          });
          // Auto-revert to ready after a short while. The user gets
          // a clear "yes, the call ended" beat, then the panel
          // becomes interactive again on its own. Cancelled if any
          // other state change (cancel, retry, leave step) intervenes.
          if (completedAutoResetHandle) clearTimeout(completedAutoResetHandle);
          completedAutoResetHandle = setTimeout(() => {
            completedAutoResetHandle = null;
            // Only auto-reset if we're still in the completed state —
            // a manual click on "Place another call" or navigation
            // away will have changed it, and we'd be stomping.
            const el = document.getElementById("df-callNowBtn");
            if (el && el.dataset.state === "completed") {
              LOG.log("call", "completed_auto_reset", {});
              refreshCallbackButton(true);
            }
          }, COMPLETED_AUTO_RESET_MS);
        } else if (outcome === "success") {
          const isVoicemail = /voicemail|answerphone|answer machine/i.test(status);
          setCallOptionState({
            state: "connected",
            title: isVoicemail ? "Off to voicemail" : "Talking now",
            desc: isVoicemail
              ? "Looks like our team can't pick up right now — we sent the call to voicemail so you can leave a message. We'll get back to you."
              : "We'll log everything for follow-up.",
            actions: ["close"],
          });
        } else if (outcome === "declined" || outcome === "no_answer" || outcome === "busy") {
          const friendly = outcome === "declined"  ? "Our team couldn't take the call right now."
                         : outcome === "no_answer" ? "Looks like nobody picked up."
                         :                           "The line was busy.";
          setCallOptionState({
            state: "failed",
            title: friendly,
            desc: "Sorry about that — try again, or pick a time below and we'll come prepared.",
            actions: ["retry", "close"],
          });
        } else {
          // Unknown terminal state — log a warning so we know to add it
          // to classifyTerminalStatus, and surface the API's string.
          LOG.warn("call", "poll_terminal_unknown_status", { status });
          setCallOptionState({
            state: "cancelled",
            title: status || "Call ended",
            desc: "If that wasn't the outcome you were hoping for, you can try again or book a slot below.",
            actions: ["retry", "close"],
          });
        }
        return;   // stop polling
      }

      // Still in flight. Three phases are worth distinguishing in
      // the copy:
      //
      //   1. Preparing — the API is setting up the call. Nothing's
      //      ringing yet, so don't tell the user to "answer when your
      //      phone rings" — that's misleading.
      //   2. Reaching team — we're calling our side first (the API
      //      surfaces this with statuses like "Calling sales..." or
      //      similar). Still don't tell the user to answer.
      //   3. Bridging to user — once the team-side connects, we ring
      //      the user's phone. This is when "answer when your phone
      //      rings" is honest.
      //   4. Connected — both sides bridged. "Talking now".
      //
      // The c2c API doesn't give us a clean enum, so we substring-
      // match the human-readable status strings. Anything we don't
      // recognise falls back to the API's text verbatim with a
      // generic supporting line.
      const lower = (status || "").toLowerCase();
      const isPreparing  = lower.includes("preparing") || lower.includes("setting up");
      const isReaching   = lower.includes("calling sales") || lower.includes("calling team") ||
                           lower.includes("reaching") || (lower.includes("calling") && !lower.includes("calling you"));
      const isBridging   = lower.includes("calling you") || lower.includes("ringing you");
      const fullyConnected = connected || lower.includes("call connected") || lower === "connected";

      let inflightTitle, inflightDesc;
      if (fullyConnected) {
        // The phrase we used to use here was ambiguous — at least one
        // user read it as "you're done with the call" rather than
        // "you're now connected", and was confused when polling
        // continued. Keep the wording present-active so it can't be
        // misread as past-tense / completion.
        inflightTitle = "Talking now";
        inflightDesc  = "We'll log everything for follow-up.";
      } else if (isPreparing) {
        inflightTitle = "Preparing your call…";
        inflightDesc  = "Just a moment — getting things set up.";
      } else if (isReaching) {
        inflightTitle = "Connecting you to a member of the team…";
        inflightDesc  = "We're trying to reach someone now.";
      } else if (isBridging) {
        inflightTitle = "Calling your phone now…";
        inflightDesc  = `We're dialling <strong>${state.phoneE164}</strong> — answer when it rings.`;
      } else {
        // Unknown in-flight status — surface the API's words rather
        // than make something up, with a softer supporting line.
        inflightTitle = status;
        inflightDesc  = "Hold tight — we'll let you know as soon as you're through.";
      }

      setCallOptionState({
        state: statusToCallState(status, cancellable, fullyConnected),
        title: inflightTitle,
        desc: inflightDesc,
        actions: fullyConnected ? ["close"] : (cancellable ? ["cancel"] : []),
      });

      activePollHandle = setTimeout(() => pollLoop(callRequestId, attempt + 1), POLL_EVERY);
    } catch (e) {
      LOG.warn("call", "poll_error_retrying", { callRequestId, attempt, error: String(e) });
      // Transient network blips shouldn't kill the panel — just retry.
      activePollHandle = setTimeout(() => pollLoop(callRequestId, attempt + 1), POLL_EVERY);
    }
  }

  /* Dispatcher for the call-now element. Click is only meaningful in
     "ready" state — closed and active states are aria-disabled and the
     event is ignored. We support keyboard activation via Enter/Space
     since the element is role="button". */
  async function handleCallNowActivate() {
    const el = document.getElementById("df-callNowBtn");
    if (!el || el.dataset.state !== "ready") {
      LOG.log("call", "activate_ignored", { currentState: el ? el.dataset.state : "no_element" });
      return;
    }
    if (!validateE164(state.phoneE164)) {
      LOG.warn("call", "activate_no_phone", { phoneE164: state.phoneE164 });
      // Should not happen — defensively pop the widget so they can fix it.
      const w = window.callWidgetInstance;
      if (w && typeof w.open === "function") w.open();
      return;
    }

    LOG.log("call", "activated", {
      phone: state.phoneE164,
      project: state.project,
      hasCompany: !!state.company,
    });

    const payload = {
      first_name: state.fname,
      last_name: state.lname,
      company: state.company || "",
      user_phone: state.phoneE164,
    };

    persist("callback_requested", {
      project: state.project,
      ...payload,
      email: state.email,
      extension: state.ext,
    });

    // Reset and start tracking lifecycle timings for this call.
    resetCallTimings();
    callTimings.requestedAt = Date.now();

    setCallOptionState({
      state: "dialling",
      title: "Preparing your call…",
      desc: "Just a moment — getting things set up.",
      actions: [],
    });

    try {
      const id = await initiateCallBack(payload);
      activeCallRequestId = id;
      LOG.log("call", "polling_started", { callRequestId: id });
      pollLoop(id);
    } catch (err) {
      LOG.error("call", "init_failed", { error: String(err && err.message || err) });
      const apiMessage = (err && err.message) ? String(err.message) : "";

      // Special case: the call API rejects with "Widget is not
      // available" when lines are closed. This is functionally
      // equivalent to availability_resolved with available:false,
      // but it arrives via the call endpoint instead. We should
      // treat it as a closed-state confirmation and not surface a
      // scary "we couldn't place the call" red error — it's not a
      // failure, it's just hours.
      //
      // TODO(connect-api): the c2c team should be informed that
      // returning HTTP 403 + "Widget is not available" via /api/v1/call
      // is awkward — it duplicates the availability check semantics
      // and forces clients to special-case the error string. Cleaner
      // would be to either (a) only ever reject via the availability
      // endpoint and expect clients to gate on it, or (b) return a
      // structured error code (e.g. {error_code: "outside_hours"}).
      if (/widget is not available/i.test(apiMessage)) {
        LOG.log("call", "init_rejected_as_closed", { reason: apiMessage });
        // Update our cached availability so refreshCallbackButton
        // renders the closed state with whatever next-open we have.
        callbackAvailable = false;
        refreshCallbackButton(true);   // forceReset to leave the active state
        // Trigger a fresh availability check too — the server may
        // have just newly closed and our cached nextOpen could be
        // out of date.
        checkCallbackAvailability();
        return;
      }

      const desc = apiMessage
        ? `Sorry — ${apiMessage}. Try again, or open the call form.`
        : "Sorry — try again, or open the call form for a manual go.";
      setCallOptionState({
        state: "failed",
        title: "We couldn't place the call",
        desc,
        actions: ["retry", "widget"],
      });
    }
  }

  document.getElementById("df-callNowBtn").addEventListener("click", handleCallNowActivate);
  document.getElementById("df-callNowBtn").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleCallNowActivate();
    }
  });

  document.getElementById("df-cancelCallBtn").addEventListener("click", async (e) => {
    e.stopPropagation();   // don't bubble up to the parent's click handler
    if (!activeCallRequestId) return;
    LOG.log("call", "cancel_requested", { callRequestId: activeCallRequestId });
    stopPolling();
    setCallOptionState({
      state: "dialling",
      title: "Cancelling…",
      desc: "Pulling the call back.",
      actions: [],
    });
    try {
      const data = await cancelCallRequest(activeCallRequestId);
      LOG.log("call", "cancel_response", { callRequestId: activeCallRequestId, body: data });
      if (data && data.success) {
        setCallOptionState({
          state: "cancelled",
          title: "Call cancelled",
          desc: "No problem — you can book a meeting above whenever it suits.",
          actions: ["close"],
        });
        persist("callback_cancelled", { callRequestId: activeCallRequestId });
      } else {
        LOG.warn("call", "cancel_rejected", { callRequestId: activeCallRequestId, body: data });
        setCallOptionState({
          state: "failed",
          title: "Couldn't cancel",
          desc: "The call may already have started. Just hang up if it's not the right time.",
          actions: ["close"],
        });
      }
    } catch (e2) {
      LOG.error("call", "cancel_failed", { callRequestId: activeCallRequestId, error: String(e2) });
      setCallOptionState({
        state: "failed",
        title: "Couldn't cancel",
        desc: "Something went wrong on our side. Sorry about that.",
        actions: ["close"],
      });
    }
    activeCallRequestId = null;
  });

  function cancelCompletedAutoReset() {
    if (completedAutoResetHandle) {
      clearTimeout(completedAutoResetHandle);
      completedAutoResetHandle = null;
    }
  }

  document.getElementById("df-closeCallBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    LOG.log("call", "panel_closed", { hadActiveRequest: !!activeCallRequestId });
    stopPolling();
    cancelCompletedAutoReset();
    activeCallRequestId = null;
    refreshCallbackButton(true);   // force reset to ready/closed
  });

  document.getElementById("df-retryCallBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    LOG.log("call", "retry_requested", {});
    cancelCompletedAutoReset();
    refreshCallbackButton(true);   // force reset before re-firing
    // Slight delay before triggering — feels less violent than a no-flicker re-fire.
    setTimeout(handleCallNowActivate, 80);
  });

  document.getElementById("df-anotherCallBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    LOG.log("call", "another_call_requested", {});
    stopPolling();
    cancelCompletedAutoReset();
    activeCallRequestId = null;
    refreshCallbackButton(true);   // back to ready, ready for another go
  });

  document.getElementById("df-openWidgetBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    LOG.log("call", "fallback_widget_opened", {});
    const w = window.callWidgetInstance;
    if (w && typeof w.open === "function") w.open();
    else LOG.warn("call", "fallback_widget_unavailable", {});
  });

  /* Dial-us click — record this so we can match conversations to the
     same lead record. The phone link still navigates as normal; we
     just fire-and-forget a persistence event before the OS handler
     takes over. */
  document.getElementById("df-dialUsBtn").addEventListener("click", () => {
    const supportNumber = SUPPORT_NUMBERS[pickSupportRegion()].e164;
    LOG.log("call", "dial_us_clicked", {
      region: pickSupportRegion(),
      supportNumber,
    });
    persist("dial_us_clicked", {
      project: state.project,
      fname: state.fname, lname: state.lname,
      company: state.company,
      email: state.email,
      phoneRaw: state.phoneRaw,
      phoneE164: state.phoneE164,
      phoneCountry: state.phoneCountry,
      extension: state.ext,
      supportNumberDialled: supportNumber,
    });
    // No preventDefault — let the tel: link do its thing.
  });

  /* ============================================
     Confirmation hydration — personalised greeting
     ============================================
     Greeting variations (keeps it fresh if someone re-books):
     "Hello {first} — when shall we speak?" no longer applies (they've
     already booked), so we use a warm, settled welcome:
       "Thanks, {first}. We'll see you then."
     Falls back to "You're booked in." if first name is missing. */
  function hydrateConfirmation() {
    const greetingEl = document.getElementById("df-confirmGreeting");
    if (state.fname) {
      greetingEl.textContent = `Thanks, ${state.fname}. See you then.`;
    } else {
      greetingEl.textContent = "You're booked in.";
    }

    document.getElementById("df-confirmProject").textContent = projectLabels[state.project] || "—";
    const tz = state.selectedTimezone || browserTimezone;
    const tzShort = tzLabel(tz);
    document.getElementById("df-confirmWhen").textContent =
      state.selectedDate.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }) +
      " at " + state.selectedSlot + " (" + tzShort + ")";
    document.getElementById("df-confirmWho").textContent = state.fname + " " + state.lname;
    document.getElementById("df-confirmEmail").textContent = state.email;
    document.getElementById("df-confirmRef").textContent = state.sessionId.slice(0, 8).toUpperCase();

    // Wire up calendar download links — they need the booked time to
    // already be in state, so this happens here.
    hydrateCalendarLinks();

    // They're booked — clear sessionStorage so a fresh visit starts
    // from scratch. We keep the state in memory for the rest of this
    // tab's life so the confirmation panel keeps rendering correctly.
    safeSessionClear();
  }

  /* ============================================
     Calendar downloads (.ics, Google, Outlook)
     ============================================
     Generates calendar entries from the booked slot + selected timezone.
     We treat the slot string ("14:00") as wall-clock in the user's
     chosen TZ, find the corresponding UTC instant, then format for each
     of the three targets:
       - .ics: DTSTART/DTEND in UTC (Z-suffix); robust for any client
       - Google Calendar: dates= YYYYMMDDTHHMMSSZ/YYYYMMDDTHHMMSSZ
       - Outlook web: ISO 8601 with Z suffix

     Caveat: converting "14:00 in Europe/London" to UTC requires knowing
     the offset on that specific date (DST). We derive it via Intl with
     timeZone option — the same trick used for the tz-offset chip. */
  const MEETING_DURATION_MIN = 20;
  const MEETING_TITLE = "DoorFlow intro call";
  const MEETING_DESCRIPTION = `A 20-minute intro to talk through your access control project.

Project: {project}
Reference: {ref}

We'll call {phone} at the scheduled time. If anything changes, just reply to the calendar invite — a real person will see it.`;

  /* Convert a wall-clock date+time in a given IANA TZ into a UTC Date.
     Uses Intl to resolve the offset for the target timezone at the
     given moment, then subtracts that offset from the wall-clock
     interpreted-as-UTC. Handles DST correctly because the offset is
     looked up *for that specific date*. */
  function tzOffsetMs(tz, utcMs) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(new Date(utcMs)).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    const local = Date.UTC(
      +parts.year, +parts.month - 1, +parts.day,
      +parts.hour === 24 ? 0 : +parts.hour, +parts.minute, +parts.second
    );
    return local - utcMs;
  }
  function wallClockToUtc(year, month, day, hour, minute, tz) {
    const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
    const offset = tzOffsetMs(tz, guess);
    return new Date(guess - offset);
  }

  function pad(n) { return String(n).padStart(2, "0"); }
  function toIcsTimestamp(d) {
    return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate())
         + "T" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + "Z";
  }

  function meetingInstants() {
    // Slot is "HH:MM"; combine with the selected date in the chosen TZ.
    const [h, m] = state.selectedSlot.split(":").map(Number);
    const d = state.selectedDate;
    const tz = state.selectedTimezone || browserTimezone;
    const startUtc = wallClockToUtc(d.getFullYear(), d.getMonth() + 1, d.getDate(), h, m, tz);
    const endUtc = new Date(startUtc.getTime() + MEETING_DURATION_MIN * 60 * 1000);
    return { startUtc, endUtc, tz };
  }

  function meetingDescription() {
    return MEETING_DESCRIPTION
      .replace("{project}", projectLabels[state.project] || "Access control project")
      .replace("{ref}", state.sessionId.slice(0, 8).toUpperCase())
      .replace("{phone}", state.phoneE164 || "your number");
  }

  function buildIcs() {
    const { startUtc, endUtc } = meetingInstants();
    const dtStamp = toIcsTimestamp(new Date());
    const uid = state.sessionId + "@doorflow.com";
    // Description must have line-folded escaping — newlines as \n, no
    // raw line breaks, commas/semicolons escaped. Keep line lengths
    // under 75 octets per the spec; for this length it's fine.
    const desc = meetingDescription().replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//DoorFlow//Contact Flow//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${dtStamp}`,
      `DTSTART:${toIcsTimestamp(startUtc)}`,
      `DTEND:${toIcsTimestamp(endUtc)}`,
      `SUMMARY:${MEETING_TITLE}`,
      `DESCRIPTION:${desc}`,
      `ORGANIZER;CN=DoorFlow:mailto:hello@doorflow.com`,
      `ATTENDEE;CN=${state.fname} ${state.lname};RSVP=TRUE:mailto:${state.email}`,
      "STATUS:CONFIRMED",
      "END:VEVENT",
      "END:VCALENDAR",
    ];
    return lines.join("\r\n");
  }

  function buildGoogleUrl() {
    const { startUtc, endUtc } = meetingInstants();
    const params = new URLSearchParams({
      action: "TEMPLATE",
      text: MEETING_TITLE,
      details: meetingDescription(),
      dates: toIcsTimestamp(startUtc) + "/" + toIcsTimestamp(endUtc),
    });
    return "https://calendar.google.com/calendar/render?" + params.toString();
  }

  function buildOutlookUrl() {
    const { startUtc, endUtc } = meetingInstants();
    const params = new URLSearchParams({
      path: "/calendar/action/compose",
      rru: "addevent",
      subject: MEETING_TITLE,
      body: meetingDescription(),
      startdt: startUtc.toISOString(),
      enddt: endUtc.toISOString(),
    });
    return "https://outlook.live.com/calendar/0/deeplink/compose?" + params.toString();
  }

  function hydrateCalendarLinks() {
    if (!state.selectedDate || !state.selectedSlot) return;

    // .ics — generate as a Blob URL, attach a download attribute.
    const ics = buildIcs();
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const icsUrl = URL.createObjectURL(blob);
    const icsLink = document.getElementById("df-downloadIcs");
    icsLink.href = icsUrl;
    icsLink.setAttribute("download", "doorflow-meeting.ics");
    icsLink.addEventListener("click", () => {
      persist("calendar_downloaded", { type: "ics" });
    });

    // Google + Outlook are URL-based.
    const gcal = document.getElementById("df-downloadGcal");
    gcal.href = buildGoogleUrl();
    gcal.addEventListener("click", () => {
      persist("calendar_downloaded", { type: "google" });
    });

    const outlook = document.getElementById("df-downloadOutlook");
    outlook.href = buildOutlookUrl();
    outlook.addEventListener("click", () => {
      persist("calendar_downloaded", { type: "outlook" });
    });
  }

  /* Start over: clear sessionStorage and reload. We've already
     cleared on confirmation but be defensive. The page reloads
     fresh from the server, no state carries over. */
  document.getElementById("df-startOverBtn").addEventListener("click", () => {
    persist("started_over", {});
    safeSessionClear();
    // Replace rather than reload so it doesn't add to history.
    window.location.replace(window.location.pathname);
  });

  /* ============================================
     Confirmation — additional attendees
     ============================================
     Optional after-the-fact addition. Each attendee is name + email,
     repeatable up to 5 (a soft cap that catches accidents but doesn't
     block legitimate teams). On every blur we validate and re-persist
     to connect.doorflow.com — so the back-end keeps growing the same
     lead record. The user gets a quiet "Saved" confirmation.

     If the user lands on step 4 directly (e.g. comes back to the page
     after booking) they shouldn't see existing attendees, since we
     clear sessionStorage on confirmation. This is a write-only block. */
  const ATTENDEE_MAX = 5;

  const attendeesToggle = document.getElementById("df-attendeesToggle");
  const attendeesForm = document.getElementById("df-attendeesForm");
  const attendeesList = document.getElementById("df-attendeesList");
  const attendeeAddBtn = document.getElementById("df-attendeeAddBtn");
  const attendeesStatus = document.getElementById("df-attendeesStatus");

  function attendeeRow(idx) {
    const row = document.createElement("div");
    row.className = "attendee-row";
    row.dataset.idx = idx;
    row.innerHTML = `
      <input type="text" placeholder="First" data-attendee-fname autocomplete="off">
      <input type="text" placeholder="Last" data-attendee-lname autocomplete="off">
      <input type="email" placeholder="email@theircompany.com" data-attendee-email autocomplete="off">
      <button type="button" class="row-remove" aria-label="Remove attendee">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>`;

    const fnameInput = row.querySelector("[data-attendee-fname]");
    const lnameInput = row.querySelector("[data-attendee-lname]");
    const emailInput = row.querySelector("[data-attendee-email]");
    const removeBtn  = row.querySelector(".row-remove");

    /* Re-use the same validation/cleaning helpers as the main form so
       attendees get the same treatment: smart name capitalisation, email
       lowercased + format-validated. Errors highlight the offending input.
       Commit happens on every blur — a partial row (e.g. just first name
       filled) does not commit, so we don't ping the server with garbage. */
    function commit() {
      const fname = fnameInput.value.trim();
      const lname = lnameInput.value.trim();
      const emailRaw = emailInput.value.trim().toLowerCase();
      if (emailRaw && emailRaw !== emailInput.value) emailInput.value = emailRaw;
      const emailValid = !emailRaw || validateEmail(emailRaw);
      emailInput.classList.toggle("has-error", emailRaw !== "" && !emailValid);
      // A row counts as "complete" only when all three fields are filled and email is valid.
      const ready = fname && lname && emailRaw && emailValid;
      if (ready) {
        state.attendees[idx] = { fname, lname, email: emailRaw };
        persistAttendees("attendee_added");
      } else if (state.attendees[idx]) {
        // They had something committed and they've backed out — drop it
        // from state so the lead record stays accurate.
        state.attendees[idx] = null;
        state.attendees = state.attendees.filter(Boolean);
        persistAttendees("attendee_removed");
      }
    }

    // Apply smartCapitalise on blur so e.g. "tom o'brien" -> "Tom O'Brien"
    // and "von dumesson" -> "von Dumesson". Same logic as the main form.
    fnameInput.addEventListener("blur", () => {
      const cleaned = smartCapitalise(fnameInput.value);
      if (cleaned !== fnameInput.value) fnameInput.value = cleaned;
      commit();
    });
    lnameInput.addEventListener("blur", () => {
      const cleaned = smartCapitalise(lnameInput.value);
      if (cleaned !== lnameInput.value) lnameInput.value = cleaned;
      commit();
    });
    emailInput.addEventListener("blur", commit);

    removeBtn.addEventListener("click", () => {
      // Splice attendee out, re-render so indexes stay tight.
      state.attendees[idx] = null;
      state.attendees = state.attendees.filter(Boolean);
      renderAttendeeRows();
      persistAttendees("attendee_removed");
    });

    return row;
  }

  function renderAttendeeRows() {
    attendeesList.innerHTML = "";
    state.attendees.forEach((a, i) => {
      const row = attendeeRow(i);
      row.querySelector("[data-attendee-fname]").value = a.fname || "";
      row.querySelector("[data-attendee-lname]").value = a.lname || "";
      row.querySelector("[data-attendee-email]").value = a.email || "";
      attendeesList.appendChild(row);
    });
    // Always have one empty trailing row up to the max.
    if (state.attendees.length < ATTENDEE_MAX) {
      const row = attendeeRow(state.attendees.length);
      attendeesList.appendChild(row);
      attendeeAddBtn.hidden = true;
    } else {
      attendeeAddBtn.hidden = false;
    }
  }

  function persistAttendees(stage) {
    LOG.log("attendee", stage, { count: state.attendees.length, attendees: state.attendees });
    persist(stage, {
      attendees: state.attendees,
      project: state.project,
      meetingDate: state.selectedDate ? state.selectedDate.toISOString().slice(0, 10) : null,
      meetingSlot: state.selectedSlot,
    });
    attendeesStatus.textContent = "Saved";
    attendeesStatus.classList.add("is-saved");
    // Fade the "Saved" hint after a couple of seconds.
    setTimeout(() => {
      attendeesStatus.textContent = "";
      attendeesStatus.classList.remove("is-saved");
    }, 1800);
  }

  attendeesToggle.addEventListener("click", () => {
    const open = attendeesForm.hidden;
    attendeesForm.hidden = !open;
    attendeesToggle.classList.toggle("is-open", open);
    attendeesToggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (open && !attendeesList.hasChildNodes()) renderAttendeeRows();
  });

  attendeeAddBtn.addEventListener("click", () => {
    // Add a fresh empty row by re-rendering — render adds a trailing
    // empty if under the cap.
    renderAttendeeRows();
  });

  /* ============================================
     Boot — rehydrate UI from sessionStorage if applicable
     ============================================
     When we get here, `state` already contains whatever was in
     sessionStorage. Now we need to push those values into the DOM:
       - tick the right project option
       - fill the form fields
       - jump to the step they were on
     If they were on step 3 (booking) we render the calendar; if on
     step 4 (confirmation) we won't restore — better to start fresh
     than to claim "you're booked!" without verifying the booking.

     This makes returning to the page after a tel: call, a tab swap,
     or a refresh feel like nothing happened. */
  function restoreUI() {
    if (!restored) return;

    // Restore project selection visually.
    if (state.project) {
      const opt = document.querySelector(`.panel[data-panel='1'] .option[data-value='${state.project}']`);
      if (opt) {
        opt.classList.add("selected");
        opt.setAttribute("aria-checked", "true");
        nextBtn1.disabled = false;
      }
    }

    // Restore form values.
    if (form) {
      if (state.fname) form.fname.value = state.fname;
      if (state.lname) form.lname.value = state.lname;
      if (state.company) form.company.value = state.company;
      if (state.email) form.email.value = state.email;
      if (state.phoneRaw) form.phone.value = state.phoneRaw;
      if (state.ext) form.ext.value = state.ext;
      // Trigger validation so the CTA enables and the phone confirm
      // pill appears for already-valid fields.
      refreshNextButton();
    }

    // Restore step. Step 4 is intentionally not auto-restored — the
    // booking ref'd a specific slot we shouldn't presume is still valid.
    if (state.step === 3) {
      setStep(3);
      renderCalendar();
      refreshTalkOptions();
      checkCallbackAvailability();
      startAvailabilityPolling();
    } else if (state.step === 2) {
      setStep(2);
    } else {
      setStep(1);
    }
  }
  restoreUI();

  /* ============================================
     Capture abandons
     ============================================ */
  window.addEventListener("pagehide", () => {
    if (state.step < 4) {
      LOG.log("session", "abandoned", { atStep: state.step });
      persist("session_abandoned", {
        atStep: state.step,
        project: state.project,
        fname: state.fname, lname: state.lname,
        company: state.company,
        email: state.email,
        phoneRaw: state.phoneRaw,
        phoneE164: state.phoneE164,
        phoneCountry: state.phoneCountry,
        ext: state.ext,
        selectedDate: state.selectedDate ? state.selectedDate.toISOString() : null,
        selectedSlot: state.selectedSlot,
      });
    } else {
      LOG.log("session", "completed", { ref: state.sessionId.slice(0, 8).toUpperCase() });
    }
  });

  /* Test hook — only fires when ?test=1 is in the URL. Exposes the
     pure functions to window so the Node test runner can poke at
     them via JSDOM. Guarded carefully: never runs in production
     because the URL there won't have the test flag. */
  if (typeof location !== "undefined" && location.search.includes("test=1")) {
    window.__doorflowInternals = {
      smartCapitalise, fixWord,
      toE164, validateE164, phoneErrorReason, countryFromE164,
      validateEmail, validateExt, validateCompany,
      classifyTerminalStatus,
      detectCountry,
      parseAsUkTime, fmtServerTime,
    };
  }
})();

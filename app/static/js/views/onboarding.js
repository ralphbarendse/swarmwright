/**
 * onboarding.js — API key setup screen shown once after first-time account
 * creation (setup.html redirects here before the hero welcome screen).
 */
import * as api from "../api.js";

const PROVIDERS = [
  { id: "anthropic", label: "Anthropic", accent: "#C97B1E", prefix: "sk-ant-", keySetting: "llm.anthropic.api_key" },
  { id: "openai",    label: "OpenAI",    accent: "#1AAF87", prefix: "sk-",     keySetting: "llm.openai.api_key"    },
  { id: "deepseek",  label: "Deepseek",  accent: "#3B82F6", prefix: "sk-",     keySetting: "llm.deepseek.api_key"  },
];

export function renderOnboardingView(container) {
  const providerPills = PROVIDERS.map(p =>
    `<button class="ob-pill" data-id="${p.id}" style="--accent:${p.accent}">${p.label}</button>`
  ).join("");

  container.innerHTML = `
    <style>
      .ob-root {
        position: absolute; inset: 0;
        background: var(--color-parchment);
        display: flex; align-items: center; justify-content: center;
        overflow: hidden;
      }
      .ob-card {
        width: 100%; max-width: 400px;
        background: var(--color-card);
        border: 1px solid var(--color-cream-line);
        border-radius: 12px;
        padding: 36px 32px;
        box-shadow: 0 4px 24px rgba(26,20,16,.07);
        animation: ob-fade-up .5s cubic-bezier(.2,.6,.2,1) both;
      }
      @keyframes ob-fade-up {
        from { opacity: 0; transform: translateY(14px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .ob-step {
        font-family: var(--font-mono); font-size: 10px; letter-spacing: .18em;
        text-transform: uppercase; color: var(--color-ink-faint); margin-bottom: 10px;
      }
      .ob-heading {
        font-family: var(--font-display); font-weight: 800; font-size: 22px;
        color: var(--color-ink); margin-bottom: 6px;
      }
      .ob-sub {
        font-size: 13px; line-height: 1.6; color: var(--color-ink-soft);
        margin-bottom: 24px;
      }
      .ob-pills { display: flex; gap: 8px; margin-bottom: 20px; }
      .ob-pill {
        flex: 1; padding: 9px 6px; border-radius: 7px; cursor: pointer;
        border: 1.5px solid var(--color-cream-line); background: var(--color-card);
        font-family: var(--font-sans); font-size: 12px; font-weight: 600;
        text-align: center; color: var(--color-ink-soft);
        transition: border-color .15s, color .15s, background .15s;
      }
      .ob-pill:hover { border-color: var(--color-ink-soft); color: var(--color-ink); }
      .ob-pill.active {
        border-color: var(--accent);
        color: var(--accent);
        background: color-mix(in srgb, var(--accent) 8%, var(--color-card));
      }
      .ob-key-section { margin-bottom: 4px; }
      .ob-label {
        font-family: var(--font-mono); font-size: 10px; letter-spacing: .12em;
        text-transform: uppercase; color: var(--color-ink-faint); margin-bottom: 6px;
      }
      .ob-row { display: flex; gap: 8px; align-items: stretch; }
      .ob-input {
        flex: 1; padding: 9px 11px;
        border: 1.5px solid var(--color-cream-line); border-radius: 6px;
        background: var(--color-surface); font-family: var(--font-mono); font-size: 12px;
        color: var(--color-ink); outline: none; transition: border-color .15s;
      }
      .ob-input:focus { border-color: var(--color-primary); }
      .ob-test-btn {
        padding: 0 14px; border: 1.5px solid var(--color-cream-line); border-radius: 6px;
        background: var(--color-card); font-family: var(--font-sans); font-size: 12px;
        font-weight: 600; color: var(--color-ink-soft); cursor: pointer; white-space: nowrap;
        transition: border-color .15s, color .15s;
      }
      .ob-test-btn:hover:not(:disabled) { border-color: var(--color-primary); color: var(--color-primary); }
      .ob-test-btn:disabled { opacity: .4; cursor: default; }
      .ob-msg {
        min-height: 20px; margin: 8px 0 16px;
        font-family: var(--font-mono); font-size: 11px; color: var(--color-ink-faint);
      }
      .ob-msg.ok  { color: var(--color-success); }
      .ob-msg.err { color: var(--color-danger); }
      .ob-save-btn {
        width: 100%; padding: 12px; border: none; border-radius: 7px;
        background: var(--color-primary); color: #FBF5E6;
        font-family: var(--font-display); font-size: 15px; font-weight: 700;
        letter-spacing: .04em; cursor: pointer;
        box-shadow: 3px 4px 0 #a0601a; transition: opacity .15s, transform .1s;
      }
      .ob-save-btn:hover:not(:disabled) { opacity: .88; }
      .ob-save-btn:active:not(:disabled) { transform: translate(1px,1px); box-shadow: 2px 3px 0 #a0601a; }
      .ob-save-btn:disabled { opacity: .35; cursor: default; box-shadow: none; }
      .ob-skip {
        display: block; text-align: center; margin-top: 12px;
        font-size: 12px; color: var(--color-ink-faint);
        background: none; border: none; cursor: pointer; width: 100%;
        padding: 4px;
      }
      .ob-skip:hover { color: var(--color-ink-soft); text-decoration: underline; }
    </style>

    <div class="ob-root">
      <div class="ob-card">
        <div class="ob-step">Step 2 of 2</div>
        <div class="ob-heading">Connect an AI provider</div>
        <div class="ob-sub">Paste an API key to power your agents. You can add more providers later in Settings.</div>

        <div class="ob-pills" id="ob-pills">${providerPills}</div>

        <div class="ob-key-section" id="ob-key-section" style="display:none">
          <div class="ob-label" id="ob-label">API Key</div>
          <div class="ob-row">
            <input id="ob-input" class="ob-input" type="password" autocomplete="off" spellcheck="false">
            <button id="ob-test" class="ob-test-btn">Test</button>
          </div>
          <div id="ob-msg" class="ob-msg"></div>
        </div>

        <button id="ob-save" class="ob-save-btn" disabled>Save &amp; Continue →</button>
        <button id="ob-skip" class="ob-skip">Skip for now</button>
      </div>
    </div>`;

  let selected = null;
  let testPassed = false;

  const keySection = container.querySelector('#ob-key-section');
  const labelEl    = container.querySelector('#ob-label');
  const inputEl    = container.querySelector('#ob-input');
  const testBtn    = container.querySelector('#ob-test');
  const msgEl      = container.querySelector('#ob-msg');
  const saveBtn    = container.querySelector('#ob-save');

  function setMsg(text, state) {
    msgEl.textContent = text;
    msgEl.className = 'ob-msg' + (state === 'ok' ? ' ok' : state === 'err' ? ' err' : '');
  }

  function resetTest() {
    testPassed = false;
    saveBtn.disabled = true;
    setMsg('', null);
  }

  // Provider selection
  container.querySelectorAll('.ob-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.ob-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selected = PROVIDERS.find(p => p.id === btn.dataset.id);
      labelEl.textContent = `${selected.label} API Key`;
      inputEl.placeholder = `${selected.prefix}…`;
      inputEl.value = '';
      keySection.style.display = '';
      inputEl.focus();
      resetTest();
    });
  });

  inputEl.addEventListener('input', resetTest);

  // Test
  testBtn.addEventListener('click', async () => {
    if (!selected) return;
    const key = inputEl.value.trim();
    if (!key) { setMsg('Enter an API key first.', 'err'); return; }
    testBtn.disabled = true;
    testBtn.textContent = 'Testing…';
    setMsg('', null);
    try {
      const r = await api.testLlmConnection({ provider: selected.id, api_key: key });
      if (r.ok) {
        setMsg('✓ ' + (r.message || 'Connection successful'), 'ok');
        testPassed = true;
        saveBtn.disabled = false;
      } else {
        setMsg('✗ ' + (r.message || 'Connection failed'), 'err');
      }
    } catch (err) {
      setMsg('✗ ' + (err?.message || 'Request failed'), 'err');
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = 'Test';
    }
  });

  // Save & continue
  saveBtn.addEventListener('click', async () => {
    if (!testPassed || !selected) return;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      await api.putSetting(selected.keySetting, {
        value: inputEl.value.trim(),
        value_type: 'string',
        is_secret: true,
        description: `${selected.label} API key`,
      });
      await api.putSetting('llm.default_provider', {
        value: selected.id,
        value_type: 'string',
        description: 'Default LLM provider',
      });
      window.swNav('welcome');
    } catch (err) {
      setMsg('✗ Could not save: ' + (err?.message || 'unknown error'), 'err');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save & Continue →';
    }
  });

  // Skip
  container.querySelector('#ob-skip').addEventListener('click', () => {
    window.swNav('welcome');
  });
}

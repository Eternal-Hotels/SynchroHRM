const loginGate = document.getElementById("login-gate");
const loginForm = document.getElementById("login-form");
const authorizedUserButton = document.getElementById("authorized-user-button");
const usernameInput = document.getElementById("username-input");
const passwordInput = document.getElementById("password-input");
const authorizedUserInput = document.getElementById("authorized-user-input");
const loginButton = document.getElementById("login-button");
const loginStatus = document.getElementById("login-status");
let isAuthorizedUserConfirmed = false;

loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void login();
});

authorizedUserButton.addEventListener("click", () => {
  revealLoginForm();
});

syncLoginControls();
setStatus("Authorized access confirmation is required before sign-in.", "empty");
void checkExistingSession();

async function checkExistingSession() {
  try {
    const payload = await fetchJson("/api/auth/me");
    window.location.href = getHomePathForUser(payload.user);
  } catch {
    authorizedUserButton.focus();
  }
}

async function login() {
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  const authorizedUserConfirmed = isAuthorizedUserConfirmed;

  setStatus("Signing in...", "empty");
  loginButton.disabled = true;

  try {
    const payload = await fetchJson("/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ username, password, authorizedUserConfirmed })
    });

    window.location.href = getHomePathForUser(payload.user);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    setStatus(message, "error");
    passwordInput.select();
  } finally {
    syncLoginControls();
  }
}

async function fetchJson(url, options) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      ...(options && options.headers ? options.headers : {})
    },
    ...options
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  return payload;
}

function setStatus(message, tone) {
  loginStatus.textContent = message;
  loginStatus.className = `form-status ${tone}`;
}

function syncLoginControls() {
  loginButton.disabled = !isAuthorizedUserConfirmed;
}

function getHomePathForUser(user) {
  return user ? "/admin" : "/login";
}

function revealLoginForm() {
  isAuthorizedUserConfirmed = true;
  authorizedUserInput.value = "true";
  loginGate.hidden = true;
  loginForm.hidden = false;
  loginForm.classList.remove("hidden");
  syncLoginControls();
  setStatus("Authorization confirmed. Sign in to continue.", "empty");
  usernameInput.focus();
}

/**
 * Authentication Logic for Login/Register Page
 */

// Check if user is already logged in
if (api.getToken()) {
  // Verify token is still valid
  api.auth.getCurrentUser()
    .then(() => {
      // Token is valid, redirect to main app
      window.location.href = '/';
    })
    .catch((error) => {
      // Only clear token if it's truly invalid/unauthorized
      if (error?.status === 401 || error?.message === 'Unauthorized') {
        api.clearToken();
      }
    });
}

// Login Form Handler
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const form = e.target;
  if (!form.checkValidity()) {
    form.classList.add('was-validated');
    return;
  }

  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  // Show loading state
  setButtonLoading('login-btn', 'login-text', 'login-spinner', true);

  try {
    const response = await api.auth.login(username, password);

    // Store token
    api.setToken(response.data.token);

    // Show success message
    showAlert('success', 'Login successful! Redirecting...');

    // Redirect to main app
    setTimeout(() => {
      window.location.href = '/';
    }, 1000);
  } catch (error) {
    // Check for account activation error
    const errorMessage = error.message || 'Login failed. Please try again.';
    if (errorMessage.includes('not activated') || errorMessage.includes('activation')) {
      showAlert('warning', errorMessage);
    } else {
      showAlert('danger', errorMessage);
    }
    setButtonLoading('login-btn', 'login-text', 'login-spinner', false);
  }
});

// Register Form Handler
document.getElementById('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const form = e.target;
  if (!form.checkValidity()) {
    form.classList.add('was-validated');
    return;
  }

  const username = document.getElementById('reg-username').value.trim();
  const password = document.getElementById('reg-password').value;
  const passwordConfirm = document.getElementById('reg-password-confirm').value;

  // Check if passwords match
  if (password !== passwordConfirm) {
    showAlert('danger', 'Passwords do not match');
    document.getElementById('reg-password-confirm').setCustomValidity('Passwords do not match');
    return;
  }

  document.getElementById('reg-password-confirm').setCustomValidity('');

  // Show loading state
  setButtonLoading('register-btn', 'register-text', 'register-spinner', true);

  try {
    const response = await api.auth.register(username, password);

    // Check if account was activated (token will be null for inactive accounts)
    if (response.data.token) {
      // Account is active, store token and redirect
      api.setToken(response.data.token);
      showAlert('success', 'Registration successful! Redirecting...');
      setTimeout(() => {
        window.location.href = '/';
      }, 1000);
    } else {
      // Account needs activation
      showAlert('info', response.message || 'Registration successful. Your account is pending activation by an administrator. You will be able to log in once your account is activated.');
      setButtonLoading('register-btn', 'register-text', 'register-spinner', false);
      
      // Clear form
      document.getElementById('reg-username').value = '';
      document.getElementById('reg-password').value = '';
      document.getElementById('reg-password-confirm').value = '';
      document.getElementById('register-form').classList.remove('was-validated');
      
      // Show login form after a delay
      setTimeout(() => {
        document.getElementById('register-card').classList.add('d-none');
        document.querySelector('.card:first-child').classList.remove('d-none');
      }, 3000);
    }
  } catch (error) {
    showAlert('danger', error.message || 'Registration failed. Please try again.');
    setButtonLoading('register-btn', 'register-text', 'register-spinner', false);
  }
});

// Show Register Form
document.getElementById('show-register').addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('register-card').classList.remove('d-none');
  document.querySelector('.card:first-child').classList.add('d-none');
});

// Show Login Form
document.getElementById('show-login').addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('register-card').classList.add('d-none');
  document.querySelector('.card:first-child').classList.remove('d-none');
});

/**
 * Show alert message
 * @param {string} type - Alert type (success, danger, warning, info)
 * @param {string} message - Alert message
 */
function showAlert(type, message) {
  const container = document.getElementById('alert-container');
  const alert = document.createElement('div');
  alert.className = `alert alert-${type} alert-dismissible fade show`;
  alert.setAttribute('role', 'alert');
  alert.innerHTML = `
    ${message}
    <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
  `;

  container.innerHTML = '';
  container.appendChild(alert);

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    alert.remove();
  }, 5000);
}

/**
 * Set button loading state
 * @param {string} btnId - Button element ID
 * @param {string} textId - Text span element ID
 * @param {string} spinnerId - Spinner span element ID
 * @param {boolean} loading - Loading state
 */
function setButtonLoading(btnId, textId, spinnerId, loading) {
  const btn = document.getElementById(btnId);
  const text = document.getElementById(textId);
  const spinner = document.getElementById(spinnerId);

  btn.disabled = loading;

  if (loading) {
    text.classList.add('d-none');
    spinner.classList.remove('d-none');
  } else {
    text.classList.remove('d-none');
    spinner.classList.add('d-none');
  }
}

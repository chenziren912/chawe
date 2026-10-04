const $ = (id) => document.getElementById(id);
const root = document.documentElement;

function show(mode) {
  const register = mode === 'register';
  $('loginForm').hidden = register;
  $('registerForm').hidden = !register;
  $('subtitle').textContent = register ? '创建新账户，设置安全密码' : '欢迎回来，请登录您的账户';
  document.title = register ? 'SnowLuma · 注册' : 'SnowLuma · 登录';
  $('loginMessage').textContent = '';
  $('registerMessage').textContent = '';
  (register ? $('registerUsername') : $('loginUsername')).focus();
}

function passwordScore(value) {
  return [value.length >= 12, /[a-z]/.test(value) && /[A-Z]/.test(value), /\d/.test(value), /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(value)].filter(Boolean).length;
}

function updateStrength() {
  const value = $('registerPassword').value;
  const score = value ? passwordScore(value) : 0;
  $('strength').dataset.score = String(score);
  $('strengthLabel').textContent = value
    ? ['请继续设置密码', '弱 · 至少 12 位，包含大小写字母、数字和特殊符号', '一般 · 继续补足密码要求', '良好 · 继续补足密码要求', '强 · 已满足全部要求'][score]
    : '至少 12 位，包含大小写字母、数字和特殊符号';
  return score;
}

async function submit(path, username, password, button, message) {
  button.disabled = true;
  message.textContent = '';
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password }),
      credentials: 'same-origin'
    });
    const data = await response.json();
    if (response.ok) {
      location.assign('/app');
      return;
    }
    const messages = {
      username_taken: '用户名已被使用。', capacity_reached: '注册人数已达到上限。',
      invalid_credentials: '用户名或密码不符合要求。', login_failed: '用户名或密码错误。',
      rate_limited: '尝试过于频繁，请稍后再试。'
    };
    message.textContent = messages[data.error] || '操作失败，请稍后再试。';
  } catch {
    message.textContent = '网络连接失败，请稍后再试。';
  } finally {
    button.disabled = false;
  }
}

$('showRegister').addEventListener('click', () => show('register'));
$('backToLogin').addEventListener('click', () => show('login'));
$('directLogin').addEventListener('click', () => show('login'));
$('registerPassword').addEventListener('input', updateStrength);

$('loginForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const username = $('loginUsername').value.trim();
  const password = $('loginPassword').value;
  if (!username || !password) return;
  submit('/api/login', username, password, $('loginButton'), $('loginMessage'));
});

$('registerForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const username = $('registerUsername').value.trim();
  const password = $('registerPassword').value;
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    $('registerMessage').textContent = '用户名需为 3-20 位字母、数字或下划线。'; return;
  }
  if (updateStrength() !== 4) {
    $('registerMessage').textContent = '请满足全部密码要求。'; return;
  }
  if (password !== $('confirmPassword').value) {
    $('registerMessage').textContent = '两次输入的密码不一致。'; return;
  }
  submit('/api/register', username, password, $('registerButton'), $('registerMessage'));
});

document.querySelectorAll('.reveal').forEach((button) => button.addEventListener('click', () => {
  const input = $(button.dataset.target);
  input.type = input.type === 'password' ? 'text' : 'password';
  button.textContent = input.type === 'password' ? '显示' : '隐藏';
  button.setAttribute('aria-label', input.type === 'password' ? '显示密码' : '隐藏密码');
}));

function setTheme(value) {
  root.dataset.theme = value;
  $('themeLabel').textContent = value === 'dark' ? '深色' : '浅色';
  localStorage.setItem('chawe_theme', value);
}
setTheme(localStorage.getItem('chawe_theme') === 'dark' ? 'dark' : 'light');
$('themeButton').addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));

function setMotion(enabled) {
  document.body.classList.toggle('reduce-motion', !enabled);
  $('motionSwitch').textContent = enabled ? '关闭背景动效' : '开启背景动效';
  localStorage.setItem('chawe_motion', enabled ? '1' : '0');
}
setMotion(localStorage.getItem('chawe_motion') !== '0');
$('motionButton').addEventListener('click', () => {
  $('motionPanel').hidden = !$('motionPanel').hidden;
  $('motionButton').setAttribute('aria-expanded', String(!$('motionPanel').hidden));
});
$('motionSwitch').addEventListener('click', () => setMotion(document.body.classList.contains('reduce-motion')));

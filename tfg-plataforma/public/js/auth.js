/**
 * Auth helper compartido — incluir en todas las páginas.
 * Comprueba la sesión en el servidor y actualiza el navbar.
 */
const Auth = (() => {

  async function getUser() {
    try {
      const res = await fetch("/api/v1/auth/me");
      if (res.ok) return (await res.json()).user;
    } catch (e) {}
    return null;
  }

  function setupNavbar(loginLi, adminLi, user) {
    if (adminLi && user.role === "admin") {
      adminLi.style.display = "list-item";
    }
    const studentLi   = document.getElementById("student-li");
    const generadorLi = document.getElementById("generador-li");
    const profeLi     = document.getElementById("profe-li");
    if (studentLi  && user.role === "alumno") studentLi.style.display  = "list-item";
    if (generadorLi && user.role === "alumno") generadorLi.style.display = "none";
    if (profeLi    && user.role === "profesor")  profeLi.style.display    = "list-item";

    const initial = user.username.charAt(0).toUpperCase();
    loginLi.innerHTML = `
      <div class="user-dropdown">
        <span id="user-btn">
          <span class="u-avatar">${initial}</span>
          <span class="u-name">${user.username}</span>
        </span>
        <div class="user-dropdown-content">
          <a href="/profile.html" class="dropdown-item">Cambiar contraseña</a>
          <a href="#" id="logout-btn" class="dropdown-item dropdown-item--danger">Cerrar sesión</a>
        </div>
      </div>`;

    document.getElementById("user-btn").addEventListener("click", () => {
      loginLi.querySelector(".user-dropdown").classList.toggle("active");
    });

    document.getElementById("logout-btn").addEventListener("click", async e => {
      e.preventDefault();
      await fetch("/api/v1/auth/logout", { method: "POST" });
      window.location.href = "/login.html";
    });
  }

  /**
   * @param {object} opts
   * @param {boolean} opts.requireAuth  - muestra acceso-denegado si no hay sesión
   */
  async function init({ requireAuth = false } = {}) {
    const user    = await getUser();
    const loginLi = document.getElementById("login-li");
    const adminLi = document.getElementById("admin-li");

    if (user) {
      setupNavbar(loginLi, adminLi, user);
    } else if (requireAuth) {
      const denied = document.getElementById("acceso-denegado");
      if (denied) denied.style.display = "flex";
      return null;
    }

    return user;
  }

  return { init, getUser };
})();

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

    loginLi.innerHTML = `
      <div class="user-dropdown">
        <span id="user-btn">Hola, ${user.username}</span>
        <div class="user-dropdown-content">
          <a href="#" id="logout-btn">Cerrar sesión</a>
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

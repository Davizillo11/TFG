# Plataforma de Gestión de Horarios Universitarios

TFG — Ingeniería Telemática, Universidad de Alcalá  
Autor: David Paluso Corral

---

## Requisitos

- [Node.js](https://nodejs.org/) v18 o superior
- npm (incluido con Node.js)

---

## Instalación y puesta en marcha

```bash
# 1. Clonar el repositorio
git clone https://github.com/Davizillo11/tfg-plataforma.git
cd tfg-plataforma

# 2. Instalar dependencias
npm install

# 3. Arrancar el servidor
npm start
```

El servidor quedará escuchando en **http://localhost:3000**

---

## Cargar la base de datos de ejemplo

El repositorio incluye una semilla (`seed.js`) con datos de prueba completos: aulas, profesores, asignaturas, grupos y usuarios para la Escuela Politécnica de la UAH.

```bash
# Ejecutar una sola vez antes de arrancar el servidor
node seed.js
```

> **Nota:** esto borra y regenera toda la base de datos. Si ya tienes datos propios, no lo ejecutes.

---

## Usuarios de prueba

| Usuario | Contraseña | Rol |
|---------|-----------|-----|
| `admin` | `admin` | Administrador |
| `david` | `david` | Alumno |

---

## Estructura del proyecto

```
tfg-plataforma/
├── server.js              # Punto de entrada
├── seed.js                # Semilla de base de datos
├── database/
│   ├── schema.js          # Creación de tablas
│   └── db.js              # Conexión SQLite
├── routes/                # API REST
│   ├── auth.js
│   ├── classrooms.js
│   ├── teachers.js
│   ├── subjects.js
│   └── schedules.js       # Algoritmo de generación
├── middleware/
│   ├── auth.js
│   └── adminOnly.js
└── public/                # Frontend
    ├── index.html
    ├── login.html
    ├── admin.html
    ├── alumno.html
    ├── horarios.html
    ├── generador.html
    └── css / js / images
```

---

## Páginas principales

| URL | Acceso | Descripción |
|-----|--------|-------------|
| `/` | Público | Landing / redirección |
| `/login.html` | Público | Inicio de sesión |
| `/admin.html` | Admin | Gestión completa + generador de horarios |
| `/horarios.html` | Público | Visualización de horarios generados |
| `/alumno.html` | Alumno | Horario personal + generador inteligente |
| `/generador.html` | Usuario | Configuración y generación de horarios |

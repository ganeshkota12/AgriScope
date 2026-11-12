import { useEffect, useState } from "react";
import {
    Navigate,
    NavLink,
    Outlet,
    Route,
    Routes,
    useLocation,
    useNavigate,
} from "react-router-dom";
import Dashboard from "./pages/Dashboard.jsx";

import Login from "./pages/Login";
import Register from "./pages/Register";
import Profile from "./pages/Profile";
import FieldConditions from "./pages/FieldConditions";
import Satellite from "./pages/Satellite";
import YieldPrediction from "./pages/YieldPrediction";

/* -------------------------------------------------------------------------- */
/*  Navigation                                                                */
/* -------------------------------------------------------------------------- */

const navigation = [
    { label: "Yield Prediction", path: "/yield-prediction", icon: "sprout" },
    { label: "Dashboard", path: "/dashboard", icon: "chart" },
    { label: "Field Conditions", path: "/field-conditions", icon: "cloud" },
    { label: "Satellite / NDVI", path: "/satellite", icon: "satellite" },
];

const PAGE_NAMES = {
    "/yield-prediction": "Yield Prediction",
    "/dashboard": "Dashboard",
    "/field-conditions": "Field Conditions",
    "/satellite": "Satellite & NDVI",
    "/profile": "My Profile",
};

function NavIcon({ name, size = 20 }) {
    const common = {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.8,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true,
    };

    switch (name) {
        case "sprout":
            return (
                <svg {...common}>
                    <path d="M12 21v-9" />
                    <path d="M12 12c0-4 2.5-6.5 7-6.5 0 4-2.5 6.5-7 6.5z" />
                    <path d="M12 14.5C12 11 9.5 9 5 9c0 3.5 2.5 5.5 7 5.5z" />
                </svg>
            );
        case "chart":
            return (
                <svg {...common}>
                    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
                </svg>
            );
        case "layers":
            return (
                <svg {...common}>
                    <path d="m12 3 9 5-9 5-9-5 9-5z" />
                    <path d="m3 13 9 5 9-5" />
                </svg>
            );
        case "cloud":
            return (
                <svg {...common}>
                    <path d="M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1 0 9H7z" />
                </svg>
            );
        case "satellite":
            return (
                <svg {...common}>
                    <circle cx="12" cy="12" r="3" />
                    <path d="M4 12a8 8 0 0 1 8-8M4 12a8 8 0 0 0 8 8M20 12a8 8 0 0 0-8-8M20 12a8 8 0 0 1-8 8" />
                </svg>
            );
        case "user":
            return (
                <svg {...common}>
                    <circle cx="12" cy="8" r="4" />
                    <path d="M4 21c1-4 4-6 8-6s7 2 8 6" />
                </svg>
            );
        case "logout":
            return (
                <svg {...common}>
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                    <path d="m16 17 5-5-5-5M21 12H9" />
                </svg>
            );
        case "menu":
            return (
                <svg {...common}>
                    <path d="M4 7h16M4 12h16M4 17h16" />
                </svg>
            );
        case "leaf":
            return (
                <svg {...common}>
                    <path d="M4 20c0-9 6-15 16-16 1 10-5 16-14 16" />
                    <path d="M4 20c3-5 7-8 12-10" />
                </svg>
            );
        default:
            return null;
    }
}

function ProtectedRoute() {
    const token = sessionStorage.getItem("access_token");
    return token ? <Outlet /> : <Navigate to="/login" replace />;
}

/* -------------------------------------------------------------------------- */
/*  Layout                                                                    */
/* -------------------------------------------------------------------------- */

function AppLayout() {
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const navigate = useNavigate();
    const location = useLocation();
    const pageName = PAGE_NAMES[location.pathname] ?? "Crop Intelligence";

    useEffect(() => {
        document.title = `${pageName} \u00B7 AgriScope`;
    }, [pageName]);

    useEffect(() => {
        if (!sidebarOpen) return undefined;
        const close = (event) => event.key === "Escape" && setSidebarOpen(false);
        window.addEventListener("keydown", close);
        return () => window.removeEventListener("keydown", close);
    }, [sidebarOpen]);

    function logout() {
        sessionStorage.removeItem("access_token");
        sessionStorage.removeItem("user");
        // Forget this session's dashboard and chat work as well.
        Object.keys(sessionStorage)
            .filter((key) => key.startsWith("agriscope-"))
            .forEach((key) => sessionStorage.removeItem(key));
        navigate("/login", { replace: true });
    }

    return (
        <div className="agri-app">
            <style>{`
                * { box-sizing: border-box; }
                body { margin: 0; }
                .agri-app {
                    min-height: 100vh;
                    background: #f6f7f1;
                    color: #26382c;
                    font-family: Inter, ui-sans-serif, system-ui, -apple-system,
                        BlinkMacSystemFont, "Segoe UI", sans-serif;
                }
                .agri-sidebar {
                    position: fixed;
                    inset: 0 auto 0 0;
                    width: 256px;
                    background: #fff;
                    border-right: 1px solid #e6e9df;
                    display: flex;
                    flex-direction: column;
                    padding: 24px 14px 18px;
                    z-index: 30;
                }
                .agri-brand {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    padding: 2px 10px 26px;
                }
                .agri-brand-icon {
                    width: 42px;
                    height: 42px;
                    border-radius: 13px;
                    background: linear-gradient(145deg, #1f4d32, #3a7b4f);
                    color: #fff;
                    display: grid;
                    place-items: center;
                }
                .agri-brand-name {
                    font-size: 18px;
                    font-weight: 800;
                    letter-spacing: 2px;
                    color: #1f4d32;
                }
                .agri-brand-sub {
                    font-size: 9px;
                    letter-spacing: 1.4px;
                    margin-top: 3px;
                    color: #788579;
                }
                .agri-nav-label {
                    padding: 8px 12px;
                    color: #8a9488;
                    font-size: 10px;
                    font-weight: 750;
                    letter-spacing: 1.5px;
                }
                .agri-nav { display: flex; flex-direction: column; gap: 4px; }
                .agri-nav-link {
                    position: relative;
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    width: 100%;
                    min-height: 44px;
                    padding: 0 12px;
                    border: 0;
                    background: transparent;
                    text-decoration: none;
                    border-radius: 11px;
                    color: #4f5f53;
                    font: inherit;
                    font-size: 13.5px;
                    font-weight: 600;
                    text-align: left;
                    cursor: pointer;
                    transition: background .15s ease, color .15s ease;
                }
                .agri-nav-link:hover { background: #f3f6ef; color: #26382c; }
                .agri-nav-link:focus-visible { outline: 2px solid #1f4d32; outline-offset: 2px; }
                .agri-nav-link.active {
                    background: #e8f2e5;
                    color: #1f4d32;
                    font-weight: 750;
                }
                .agri-nav-link.active::before {
                    content: "";
                    position: absolute;
                    left: -14px;
                    top: 9px;
                    bottom: 9px;
                    width: 4px;
                    border-radius: 0 4px 4px 0;
                    background: #1f4d32;
                }
                .agri-nav-icon { display: grid; place-items: center; width: 22px; flex-shrink: 0; }
                .agri-sidebar-bottom {
                    margin-top: auto;
                    border-top: 1px solid #edf0e9;
                    padding-top: 14px;
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                .agri-logout:hover { background: #fdf1ee; color: #9b2c1f; }
                .agri-main { margin-left: 256px; min-height: 100vh; }
                .agri-topbar {
                    position: sticky;
                    top: 0;
                    z-index: 20;
                    height: 64px;
                    padding: 0 35px;
                    background: rgba(255,255,255,.94);
                    border-bottom: 1px solid #e7eae2;
                    display: flex;
                    align-items: center;
                    gap: 14px;
                    backdrop-filter: blur(12px);
                }
                .agri-breadcrumb { font-size: 13px; color: #7d897d; }
                .agri-breadcrumb strong { color: #26382c; font-weight: 700; }
                .agri-content { padding: 28px 35px 44px; }
                .agri-soon {
                    max-width: 760px;
                    margin: 12px auto;
                    border: 1px solid #e2e8dc;
                    border-radius: 20px;
                    background: #fff;
                    padding: clamp(26px, 5vw, 52px);
                    text-align: left;
                }
                .agri-soon-badge {
                    display: inline-block;
                    padding: 5px 12px;
                    border-radius: 999px;
                    background: #e8f2e5;
                    color: #1f4d32;
                    font-size: 11.5px;
                    font-weight: 750;
                }
                .agri-soon h1 {
                    font-size: clamp(26px, 4vw, 38px);
                    letter-spacing: -1px;
                    margin: 16px 0 10px;
                }
                .agri-soon p { color: #667567; line-height: 1.8; max-width: 580px; margin: 0; }
                .agri-mobile-menu { display: none; }
                .agri-overlay { display: none; }

                @media (max-width: 850px) {
                    .agri-sidebar {
                        transform: translateX(-100%);
                        transition: transform .2s ease;
                        box-shadow: 0 0 40px rgba(18,30,20,.18);
                    }
                    .agri-sidebar.open { transform: translateX(0); }
                    .agri-main { margin-left: 0; }
                    .agri-topbar { padding: 0 16px; }
                    .agri-content { padding: 20px 16px 35px; }
                    .agri-mobile-menu {
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        width: 40px;
                        height: 40px;
                        border: 1px solid #e1e7dc;
                        background: white;
                        border-radius: 10px;
                        color: #26382c;
                        cursor: pointer;
                    }
                    .agri-overlay.visible {
                        display: block;
                        position: fixed;
                        inset: 0;
                        background: rgba(18,30,20,.32);
                        z-index: 25;
                    }
                }
            `}</style>

            <div
                className={`agri-overlay ${sidebarOpen ? "visible" : ""}`}
                onClick={() => setSidebarOpen(false)}
            />

            <aside className={`agri-sidebar ${sidebarOpen ? "open" : ""}`}>
                <div className="agri-brand">
                    <div className="agri-brand-icon">
                        <NavIcon name="leaf" size={22} />
                    </div>
                    <div>
                        <div className="agri-brand-name">AGRISCOPE</div>
                        <div className="agri-brand-sub">CROP INTELLIGENCE</div>
                    </div>
                </div>

                <div className="agri-nav-label">WORKSPACE</div>

                <nav className="agri-nav" aria-label="Main navigation">
                    {navigation.map((item) => (
                        <NavLink
                            key={item.path}
                            to={item.path}
                            onClick={() => setSidebarOpen(false)}
                            className={({ isActive }) =>
                                `agri-nav-link ${isActive ? "active" : ""}`
                            }
                        >
                            <span className="agri-nav-icon">
                                <NavIcon name={item.icon} />
                            </span>
                            <span>{item.label}</span>
                        </NavLink>
                    ))}
                </nav>

                <div className="agri-sidebar-bottom">
                    <NavLink
                        to="/profile"
                        onClick={() => setSidebarOpen(false)}
                        className={({ isActive }) =>
                            `agri-nav-link ${isActive ? "active" : ""}`
                        }
                    >
                        <span className="agri-nav-icon">
                            <NavIcon name="user" />
                        </span>
                        <span>My Profile</span>
                    </NavLink>

                    <button type="button" className="agri-nav-link agri-logout" onClick={logout}>
                        <span className="agri-nav-icon">
                            <NavIcon name="logout" />
                        </span>
                        <span>Log out</span>
                    </button>
                </div>
            </aside>

            <div className="agri-main">
                <header className="agri-topbar">
                    <button
                        type="button"
                        className="agri-mobile-menu"
                        onClick={() => setSidebarOpen(true)}
                        aria-label="Open navigation"
                    >
                        <NavIcon name="menu" />
                    </button>
                    <div className="agri-breadcrumb">
                        AgriScope <span> / </span> <strong>{pageName}</strong>
                    </div>
                </header>

                <main className="agri-content">
                    <Outlet />
                </main>
            </div>
        </div>
    );
}

/* -------------------------------------------------------------------------- */
/*  Pages that are not ready yet                                              */
/* -------------------------------------------------------------------------- */

const comingSoon = {
};

function ComingSoon({ path }) {
    const page = comingSoon[path];
    return (
        <section className="agri-soon">
            <span className="agri-soon-badge">Coming soon</span>
            <h1>{page.title}</h1>
            <p>{page.description}</p>
        </section>
    );
}

/* -------------------------------------------------------------------------- */
/*  Routes                                                                    */
/* -------------------------------------------------------------------------- */

function AppRoutes() {
    return (
        <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />

            <Route element={<ProtectedRoute />}>
                <Route element={<AppLayout />}>
                    <Route
                        path="/"
                        element={<Navigate to="/yield-prediction" replace />}
                    />

                    <Route path="/yield-prediction" element={<YieldPrediction />} />
                    <Route path="/dashboard" element={<Dashboard />} />
                    <Route path="/profile" element={<Profile />} />
                    <Route path="/field-conditions" element={<FieldConditions />} />
                    <Route path="/satellite" element={<Satellite />} />
                    <Route path="/weather-analysis" element={<Navigate to="/field-conditions" replace />} />
                    <Route path="/soil-analysis" element={<Navigate to="/field-conditions" replace />} />

                    {Object.keys(comingSoon).map((path) => (
                        <Route
                            key={path}
                            path={path}
                            element={<ComingSoon path={path} />}
                        />
                    ))}
                </Route>
            </Route>

            <Route
                path="*"
                element={<Navigate to="/yield-prediction" replace />}
            />
        </Routes>
    );
}

export default function App() {
    return <AppRoutes />;
}
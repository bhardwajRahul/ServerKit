import { Routes, Route, Navigate } from 'react-router-dom';
import Shell from './components/Shell.jsx';
import Overview from './pages/Overview.jsx';
import Activity from './pages/Activity.jsx';
import Logs from './pages/Logs.jsx';
import Actions from './pages/Actions.jsx';
import About from './pages/About.jsx';

export default function App() {
    return (
        <Routes>
            <Route element={<Shell />}>
                <Route path="/overview" element={<Overview />} />
                <Route path="/activity" element={<Activity />} />
                <Route path="/logs" element={<Logs />} />
                <Route path="/actions" element={<Actions />} />
                <Route path="/about" element={<About />} />
            </Route>
            <Route path="*" element={<Navigate to="/overview" replace />} />
        </Routes>
    );
}

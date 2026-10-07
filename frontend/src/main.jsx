import './styles/index.css';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

const rootEl = document.getElementById('root');
const githubUrl = rootEl?.dataset.githubUrl || '';

createRoot(rootEl).render(<App githubUrl={githubUrl} />);

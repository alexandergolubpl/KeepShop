// Точка входа: стили, шрифт, карта, нативная часть и само приложение.
import './styles.css';
import 'leaflet/dist/leaflet.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import './leaflet-icons';
import { setupNativeUi } from './native';
import './app';

setupNativeUi();

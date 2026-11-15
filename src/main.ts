import "./ui/theme.css";
import { App } from "./ui/app";
import { menuScreen } from "./ui/screens/menu";
import { mountTitlebar } from "./ui/titlebar";

mountTitlebar();
const app = new App(document.getElementById("app")!);
app.show(menuScreen);
// Debug handle for the developer console and automated UI checks.
(window as unknown as { bastides: App }).bastides = app;

import { ResourceMonitor, type ResourceSection } from "../components/ResourceMonitor";
import { useAppServices } from "../core/appServices";

function Resource({ section }: { section: ResourceSection }) { const app = useAppServices(); return <ResourceMonitor latest={app.resources.at(-1) ?? null} history={app.resources} sections={[section]} />; }
export const SummaryModuleWidget = () => <Resource section="summary" />;
export const ThermalsModuleWidget = () => <Resource section="thermals" />;
export const PcieModuleWidget = () => <Resource section="pcie" />;
export const ComputeModuleWidget = () => <Resource section="compute" />;
export const DetailsModuleWidget = () => <Resource section="details" />;

import WorkspaceApplicationsTab from './WorkspaceApplicationsTab';

export default function WorkspaceServicesTab({ services, ...props }) {
    return <WorkspaceApplicationsTab {...props} kind="services" rows={services} />;
}

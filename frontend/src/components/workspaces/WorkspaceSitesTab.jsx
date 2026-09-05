import WorkspaceApplicationsTab from './WorkspaceApplicationsTab';

export default function WorkspaceSitesTab({ sites, ...props }) {
    return <WorkspaceApplicationsTab {...props} kind="sites" rows={sites} />;
}

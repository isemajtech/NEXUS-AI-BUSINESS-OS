import React, { useState } from 'react';
import { useOS } from '../../context/OSContext';
import { Project, DeploymentStatus } from '../../types';
import { Badge, Modal, EmptyState } from '../common/UIComponents';
import {
  Globe,
  Plus,
  Github,
  ExternalLink,
  Activity,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Layers,
  Edit2,
  Trash2,
  RefreshCw,
} from 'lucide-react';

export const WebsitesApps: React.FC = () => {
  const {
    projects,
    businesses,
    selectedBusinessId,
    addProject,
    updateProject,
    deleteProject,
    pingProjectHealth,
  } = useOS();

  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [pingingId, setPingingId] = useState<string | null>(null);

  // Form states
  const [name, setName] = useState('');
  const [businessId, setBusinessId] = useState(
    selectedBusinessId !== 'all' ? selectedBusinessId : (businesses[0]?.id || '')
  );
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [githubUrl, setGithubUrl] = useState('');
  const [techStackInput, setTechStackInput] = useState('React, TypeScript, Tailwind, Supabase');
  const [deploymentStatus, setDeploymentStatus] = useState<DeploymentStatus>('live');
  const [notes, setNotes] = useState('');

  const filteredProjects = selectedBusinessId === 'all'
    ? projects
    : projects.filter((p) => p.businessId === selectedBusinessId);

  const handleOpenAdd = () => {
    setName('');
    setBusinessId(selectedBusinessId !== 'all' ? selectedBusinessId : (businesses[0]?.id || ''));
    setWebsiteUrl('');
    setGithubUrl('');
    setTechStackInput('React, TypeScript, Tailwind, Supabase');
    setDeploymentStatus('live');
    setNotes('');
    setIsAddModalOpen(true);
  };

  const handleOpenEdit = (proj: Project) => {
    setEditingProject(proj);
    setName(proj.name);
    setBusinessId(proj.businessId);
    setWebsiteUrl(proj.websiteUrl || '');
    setGithubUrl(proj.githubUrl || '');
    setTechStackInput(proj.techStack.join(', '));
    setDeploymentStatus(proj.deploymentStatus);
    setNotes(proj.notes || '');
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !businessId) return;

    const stack = techStackInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    addProject({
      name: name.trim(),
      businessId,
      description: notes.trim() || 'Production application in registry.',
      websiteUrl: websiteUrl.trim(),
      githubUrl: githubUrl.trim(),
      techStack: stack,
      deploymentStatus,
      notes: notes.trim(),
      lastCheckedDate: new Date().toISOString(),
    });

    setIsAddModalOpen(false);
  };

  const handleUpdate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProject || !name.trim()) return;

    const stack = techStackInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    updateProject(editingProject.id, {
      name: name.trim(),
      businessId,
      websiteUrl: websiteUrl.trim(),
      githubUrl: githubUrl.trim(),
      techStack: stack,
      deploymentStatus,
      notes: notes.trim(),
    });

    setEditingProject(null);
  };

  const handlePing = async (id: string) => {
    setPingingId(id);
    await pingProjectHealth(id);
    setTimeout(() => setPingingId(null), 600);
  };

  const statusBadge = (status: DeploymentStatus) => {
    switch (status) {
      case 'live':
        return <Badge variant="emerald">Live Production</Badge>;
      case 'staging':
        return <Badge variant="blue">Staging</Badge>;
      case 'in_progress':
        return <Badge variant="amber">In Development</Badge>;
      case 'degraded':
        return <Badge variant="amber">Degraded</Badge>;
      case 'down':
        return <Badge variant="rose">Down</Badge>;
      default:
        return <Badge variant="neutral">Draft</Badge>;
    }
  };

  return (
    <div className="space-y-6 pb-20 sm:pb-8 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-2xl bg-[#0e131d] border border-[#1e2638]">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Globe className="w-4 h-4 text-violet-400" />
            <span className="text-xs font-mono font-medium text-violet-400 uppercase tracking-wider">
              Fleet & Infrastructure Registry
            </span>
          </div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-100">Websites & Apps</h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-0.5">
            Sovereign catalog of all client-facing web apps, APIs, microservices, and repositories.
          </p>
        </div>

        <button
          onClick={handleOpenAdd}
          className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-xl shadow-sm transition-colors flex items-center gap-1.5 self-start sm:self-auto"
        >
          <Plus className="w-4 h-4" />
          Register Project
        </button>
      </div>

      {/* Projects List */}
      {filteredProjects.length === 0 ? (
        <EmptyState
          icon={<Globe className="w-8 h-8 text-blue-400" />}
          title="No Websites or Applications Registered"
          description="Track your repositories, production URLs, tech stacks, and real-time operational status."
          actionText="Register First Project"
          onAction={handleOpenAdd}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filteredProjects.map((proj) => {
            const biz = businesses.find((b) => b.id === proj.businessId);

            return (
              <div
                key={proj.id}
                className="p-5 rounded-2xl bg-[#0f1422] border border-[#1e273a] hover:border-slate-600 transition-all space-y-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-bold text-slate-100">{proj.name}</h3>
                      {statusBadge(proj.deploymentStatus)}
                    </div>
                    <span className="text-xs font-mono text-slate-400">
                      Venture: <strong className="text-slate-300">{biz?.name || 'Unassigned'}</strong>
                    </span>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handlePing(proj.id)}
                      disabled={pingingId === proj.id}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-emerald-400 hover:bg-[#182133] transition-colors"
                      title="Run Availability Health Ping"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${pingingId === proj.id ? 'animate-spin text-emerald-400' : ''}`} />
                    </button>
                    <button
                      onClick={() => handleOpenEdit(proj)}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-[#182133] transition-colors"
                      title="Edit Registry"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => deleteProject(proj.id)}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-[#182133] transition-colors"
                      title="Delete Project"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {proj.notes && (
                  <p className="text-xs text-slate-300 line-clamp-2 leading-relaxed">
                    {proj.notes}
                  </p>
                )}

                {/* Tech Stack Pills */}
                <div className="flex flex-wrap gap-1.5">
                  {proj.techStack.map((tech, idx) => (
                    <span
                      key={idx}
                      className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#161d2d] text-slate-300 border border-[#232f45]"
                    >
                      {tech}
                    </span>
                  ))}
                </div>

                {/* External links & health check state */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-[#1a2335] text-xs">
                  <div className="flex items-center gap-3">
                    {proj.websiteUrl && (
                      <a
                        href={proj.websiteUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:underline flex items-center gap-1 font-mono text-[11px]"
                      >
                        <Globe className="w-3.5 h-3.5" />
                        URL
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                    {proj.githubUrl && (
                      <a
                        href={proj.githubUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-slate-300 hover:text-white flex items-center gap-1 font-mono text-[11px]"
                      >
                        <Github className="w-3.5 h-3.5" />
                        Repository
                      </a>
                    )}
                  </div>

                  <div className="flex items-center gap-1 text-[11px] font-mono text-slate-400">
                    <Clock className="w-3 h-3 text-slate-400" />
                    Checked: {proj.lastCheckedDate ? new Date(proj.lastCheckedDate).toLocaleDateString() : 'Pending'}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add Project Modal */}
      <Modal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        title="Register Website or Application"
        maxWidth="md"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Project Name *</label>
            <input
              type="text"
              required
              placeholder="e.g. Apex Edge Gateway"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Business Association *</label>
            <select
              required
              value={businessId}
              onChange={(e) => setBusinessId(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            >
              {businesses.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Website URL</label>
              <input
                type="url"
                placeholder="https://app.example.com"
                value={websiteUrl}
                onChange={(e) => setWebsiteUrl(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Deployment Status</label>
              <select
                value={deploymentStatus}
                onChange={(e) => setDeploymentStatus(e.target.value as DeploymentStatus)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              >
                <option value="live">Live Production</option>
                <option value="staging">Staging</option>
                <option value="in_progress">In Development</option>
                <option value="draft">Draft</option>
                <option value="degraded">Degraded</option>
                <option value="down">Down</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">GitHub Repository URL</label>
            <input
              type="url"
              placeholder="https://github.com/org/repo"
              value={githubUrl}
              onChange={(e) => setGithubUrl(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Tech Stack (comma separated)</label>
            <input
              type="text"
              placeholder="Next.js, Node.js, TypeScript, Tailwind, Supabase"
              value={techStackInput}
              onChange={(e) => setTechStackInput(e.target.value)}
              className="w-full px-3 py-2 text-xs font-mono rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Architecture Notes</label>
            <textarea
              rows={3}
              placeholder="Hosting details, environment variables, dependencies..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setIsAddModalOpen(false)}
              className="px-3 py-2 text-xs text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow-sm"
            >
              Save Project
            </button>
          </div>
        </form>
      </Modal>

      {/* Edit Project Modal */}
      {editingProject && (
        <Modal
          isOpen={true}
          onClose={() => setEditingProject(null)}
          title={`Edit ${editingProject.name}`}
          maxWidth="md"
        >
          <form onSubmit={handleUpdate} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Project Name</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Deployment Status</label>
              <select
                value={deploymentStatus}
                onChange={(e) => setDeploymentStatus(e.target.value as DeploymentStatus)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              >
                <option value="live">Live Production</option>
                <option value="staging">Staging</option>
                <option value="in_progress">In Development</option>
                <option value="draft">Draft</option>
                <option value="degraded">Degraded</option>
                <option value="down">Down</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Website URL</label>
              <input
                type="url"
                value={websiteUrl}
                onChange={(e) => setWebsiteUrl(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Tech Stack</label>
              <input
                type="text"
                value={techStackInput}
                onChange={(e) => setTechStackInput(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditingProject(null)}
                className="px-3 py-2 text-xs text-slate-400 hover:text-slate-200"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow-sm"
              >
                Save Updates
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
};

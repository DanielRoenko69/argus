import { useState, type FormEvent } from 'react';
import { AlertTriangle, Bot, FileText, Save, Sparkles, Trash2, X } from 'lucide-react';
import type { SkillMutation, SkillOption } from '../types';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
}

export function SkillEditor({
  skill,
  busy,
  error,
  onClose,
  onSave,
  onDelete,
}: {
  skill: SkillOption | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (input: SkillMutation) => void;
  onDelete: (skill: SkillOption) => void;
}) {
  const [name, setName] = useState(skill?.name ?? '');
  const [nameTouched, setNameTouched] = useState(Boolean(skill));
  const [label, setLabel] = useState(skill?.label ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [category, setCategory] = useState(skill?.category ?? '');
  const [icon, setIcon] = useState(skill?.icon ?? '✦');
  const [content, setContent] = useState(skill?.content ?? '');
  const [validation, setValidation] = useState('');
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleteName, setDeleteName] = useState('');
  const assignments = skill?.assigned_agents ?? [];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const normalizedName = name.trim();
    const normalizedLabel = label.trim();
    const normalizedContent = content.trim();
    if (!/^[a-z0-9_-]+$/.test(normalizedName)) {
      setValidation('Technical name may contain lowercase letters, numbers, hyphens and underscores only.');
      return;
    }
    if (!normalizedLabel) {
      setValidation('Display name is required.');
      return;
    }
    if (!normalizedContent) {
      setValidation('Prompt content is required.');
      return;
    }
    setValidation('');
    onSave({
      name: normalizedName,
      label: normalizedLabel,
      description: description.trim(),
      content: normalizedContent,
      category: category.trim() || null,
      icon: icon.trim() || '✦',
    });
  };

  return (
    <div className="editor-layer" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}>
      <section className="bundle-editor skill-editor" role="dialog" aria-modal="true" aria-labelledby="skill-editor-title" onMouseDown={event => event.stopPropagation()}>
        <header className="editor-header">
          <div><span className="eyebrow">BUILD · SKILL LIBRARY</span><h2 id="skill-editor-title">{skill ? `Edit ${skill.label}` : 'Create reusable skill'}</h2><p>Curate a prompt fragment once, then attach it to agents and governed bundles.</p></div>
          <button className="editor-close" type="button" aria-label="Close skill editor" disabled={busy} onClick={onClose}><X size={18} /></button>
        </header>

        <form className="skill-editor-form" onSubmit={submit}>
          <section className="editor-section">
            <div className="editor-section-heading"><span><Sparkles size={17} /></span><div><small>IDENTITY</small><h3>Name and catalog placement</h3></div>{skill && <strong>NAME LOCKED</strong>}</div>
            <div className="skill-field-grid">
              <label className="editor-field"><span>Technical name <em>required</em></span><input required maxLength={128} disabled={skill != null} value={name} onChange={event => { setNameTouched(true); setName(event.target.value); }} placeholder="incident-triage" /></label>
              <label className="editor-field"><span>Display name <em>required</em></span><input required maxLength={256} value={label} onChange={event => { const next = event.target.value; setLabel(next); if (!nameTouched) setName(slugify(next)); }} placeholder="Incident Triage" /></label>
              <label className="editor-field"><span>Category</span><input maxLength={64} list="skill-categories" value={category} onChange={event => setCategory(event.target.value)} placeholder="operations" /><datalist id="skill-categories"><option value="operations" /><option value="coding" /><option value="analysis" /><option value="security" /><option value="governance" /></datalist></label>
              <label className="editor-field"><span>Icon</span><input maxLength={32} value={icon} onChange={event => setIcon(event.target.value)} placeholder="✦" /></label>
            </div>
            <label className="editor-field"><span>Description</span><textarea rows={3} maxLength={1000} value={description} onChange={event => setDescription(event.target.value)} placeholder="When and why an agent should use this instruction set." /></label>
          </section>

          <section className="editor-section skill-content-section">
            <div className="editor-section-heading"><span><FileText size={17} /></span><div><small>PROMPT FRAGMENT</small><h3>Instructions injected at runtime</h3></div><strong>{content.length.toLocaleString()} CHARS</strong></div>
            <label className="editor-field"><span>Markdown content <em>required</em></span><textarea className="prompt-textarea skill-content-input" rows={18} required value={content} onChange={event => setContent(event.target.value)} placeholder={'## Incident triage\n\n1. Gather current evidence before proposing a change.\n2. Correlate logs, metrics and recent deployments.\n3. State confidence and rollback options.'} /><small>This text is appended to an eligible agent's system prompt and exposed as an MCP prompt when assigned through a bundle.</small></label>
          </section>

          {skill && <section className="editor-section skill-usage-section">
            <div className="editor-section-heading"><span><Bot size={17} /></span><div><small>IMPACT</small><h3>Assigned agents</h3></div><strong>{assignments.length} AGENTS</strong></div>
            {assignments.length > 0 ? <div className="skill-assignment-list">{assignments.map(agent => <span className={agent.enabled ? '' : 'is-disabled'} key={agent.id}><Bot size={12} /><b>{agent.label}</b><small>{agent.name}</small></span>)}</div> : <p className="editor-section-description">This skill is not assigned to an agent. It may still be referenced by bundles, workflows or technical identities.</p>}
            {skill.source_url && <div className="skill-source-warning"><AlertTriangle size={14} /><span><b>Imported skill</b><small>Manual edits can be overwritten by a future sync from {skill.source_url}{skill.source_ref ? ` · ${skill.source_ref}` : ''}.</small></span></div>}
          </section>}

          {(validation || error) && <div className="editor-error" role="alert"><AlertTriangle size={15} /><span>{validation || error}</span></div>}

          <footer className="editor-footer skill-editor-footer">
            <div>{skill && (!deleteArmed
              ? <button className="button editor-delete" type="button" disabled={busy} onClick={() => setDeleteArmed(true)}><Trash2 size={14} />Delete skill</button>
              : <div className="skill-delete-confirm"><span>{assignments.length > 0 ? `Removes assignments from ${assignments.length} agents. ` : ''}Type <code>{skill.name}</code> to confirm.</span><input value={deleteName} onChange={event => setDeleteName(event.target.value)} aria-label={`Type ${skill.name} to confirm deletion`} placeholder={skill.name} /><button className="button button-danger" type="button" disabled={busy || deleteName !== skill.name} onClick={() => onDelete(skill)}>Confirm delete</button><button className="button button-secondary" type="button" onClick={() => { setDeleteArmed(false); setDeleteName(''); }}>Cancel</button></div>)}</div>
            <div><button className="button button-secondary" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button button-primary" type="submit" disabled={busy}><Save size={14} />{busy ? 'Saving…' : skill ? 'Save skill' : 'Create skill'}</button></div>
          </footer>
        </form>
      </section>
    </div>
  );
}

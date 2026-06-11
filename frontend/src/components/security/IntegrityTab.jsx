import React, { useState } from 'react';
import api from '../../services/api';
import { Button } from '@/components/ui/button';

const IntegrityTab = () => {
    const [checking, setChecking] = useState(false);
    const [initializing, setInitializing] = useState(false);
    const [results, setResults] = useState(null);
    const [message, setMessage] = useState(null);

    async function handleInitialize() {
        if (!confirm('This will create a new baseline for file integrity monitoring. Continue?')) return;

        setInitializing(true);
        setMessage(null);
        try {
            const result = await api.initializeIntegrityDatabase();
            setMessage({ type: 'success', text: result.message });
        } catch (err) {
            setMessage({ type: 'error', text: err.message });
        } finally {
            setInitializing(false);
        }
    }

    async function handleCheck() {
        setChecking(true);
        setMessage(null);
        try {
            const result = await api.checkFileIntegrity();
            setResults(result);
            if (result.total_changes === 0) {
                setMessage({ type: 'success', text: 'No changes detected' });
            }
        } catch (err) {
            setMessage({ type: 'error', text: err.message });
        } finally {
            setChecking(false);
        }
    }

    return (
        <div className="integrity-tab">
            {message && (
                <div className={`alert alert-${message.type === 'success' ? 'success' : 'danger'}`}>
                    {message.text}
                </div>
            )}

            <div className="card">
                <div className="card-header">
                    <h3>File Integrity Monitoring</h3>
                </div>
                <div className="card-body">
                    <p className="description">
                        File integrity monitoring tracks changes to critical system files. Initialize a baseline database,
                        then periodically check for unauthorized modifications.
                    </p>

                    <div className="integrity-actions">
                        <Button
                            variant="outline"
                            onClick={handleInitialize}
                            disabled={initializing}
                        >
                            {initializing ? 'Initializing...' : 'Initialize Baseline'}
                        </Button>
                        <Button
                            variant="default"
                            onClick={handleCheck}
                            disabled={checking}
                        >
                            {checking ? 'Checking...' : 'Check Integrity'}
                        </Button>
                    </div>
                </div>
            </div>

            {results && results.total_changes > 0 && (
                <div className="card">
                    <div className="card-header">
                        <h3>Changes Detected</h3>
                        <span className="sec-state sec-state--amber">{results.total_changes} changes</span>
                    </div>
                    <div className="card-body">
                        {results.changes.modified?.length > 0 && (
                            <div className="change-section">
                                <div className="sec-change-head">
                                    <span className="sec-state sec-state--amber">modified</span>
                                    <span className="sec-change-count">{results.changes.modified.length} files</span>
                                </div>
                                <ul className="file-list">
                                    {results.changes.modified.map((file, i) => (
                                        <li key={i}>{file.path}</li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {results.changes.deleted?.length > 0 && (
                            <div className="change-section">
                                <div className="sec-change-head">
                                    <span className="sec-state sec-state--red">deleted</span>
                                    <span className="sec-change-count">{results.changes.deleted.length} files</span>
                                </div>
                                <ul className="file-list">
                                    {results.changes.deleted.map((file, i) => (
                                        <li key={i}>{file}</li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {results.changes.new?.length > 0 && (
                            <div className="change-section">
                                <div className="sec-change-head">
                                    <span className="sec-state sec-state--cyan">added</span>
                                    <span className="sec-change-count">{results.changes.new.length} files</span>
                                </div>
                                <ul className="file-list">
                                    {results.changes.new.slice(0, 50).map((file, i) => (
                                        <li key={i}>{file}</li>
                                    ))}
                                    {results.changes.new.length > 50 && (
                                        <li className="text-muted">... and {results.changes.new.length - 50} more</li>
                                    )}
                                </ul>
                            </div>
                        )}

                        {results.changes.permission_changed?.length > 0 && (
                            <div className="change-section">
                                <div className="sec-change-head">
                                    <span className="sec-state sec-state--violet">permissions</span>
                                    <span className="sec-change-count">{results.changes.permission_changed.length} files</span>
                                </div>
                                <ul className="file-list">
                                    {results.changes.permission_changed.map((file, i) => (
                                        <li key={i}>{file.path} ({file.old_mode} → {file.new_mode})</li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default IntegrityTab;

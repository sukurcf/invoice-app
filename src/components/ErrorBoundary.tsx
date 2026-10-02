import { Component, type ErrorInfo, type ReactNode } from "react";

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Application rendering failed", error, info.componentStack);
  }
  render() {
    if (this.state.failed) return <main className="empty-state" role="alert"><h1>Something went wrong</h1><p>Saved data remains on the server. Reload the application to try again.</p><button className="button primary" type="button" onClick={() => window.location.reload()}>Reload application</button></main>;
    return this.props.children;
  }
}

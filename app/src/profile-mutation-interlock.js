class ProfileMutationInterlock {
  constructor() {
    this.mutation = null;
    this.transferClaims = 0;
  }

  beginTransfer() {
    if (this.mutation) {
      const error = new Error(`Connection settings are changing (${this.mutation}). Try the transfer again in a moment.`);
      error.code = 'EPROFILEMUTATION';
      error.retryable = true;
      throw error;
    }
    this.transferClaims += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.transferClaims = Math.max(0, this.transferClaims - 1);
    };
  }

  async runExclusive(label, operation) {
    if (this.mutation) throw new Error(`Another connection change is already running (${this.mutation}).`);
    if (this.transferClaims > 0) {
      const error = new Error('A transfer is active. Wait for it to finish or pause it before changing the rclone profile.');
      error.code = 'ETRANSFERACTIVE';
      throw error;
    }
    this.mutation = String(label || 'connection change');
    try {
      return await operation();
    } finally {
      this.mutation = null;
    }
  }

  snapshot() {
    return { mutation: this.mutation || '', transferClaims: this.transferClaims };
  }
}

module.exports = { ProfileMutationInterlock };

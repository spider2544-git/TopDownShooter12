class ModeTimer {
	constructor() {
		this.sequence = [
			{ name: 'Search', duration: 10 },
			{ name: 'Guard', duration: 60 }
		];
		this.index = 0;
		this.currentName = this.sequence[0].name;
		this.timeLeft = this.sequence[0].duration;
		this.serverDriven = false;  // Set to true for server-driven modes (Extraction)
	}

	update(dt) {
		// Skip local updates if server-driven (Extraction mode uses server phase timer)
		if (this.serverDriven) return;
		
		if (!Number.isFinite(dt) || dt <= 0) return;
		this.timeLeft -= dt;
		if (this.timeLeft <= 0) {
			this.index = (this.index + 1) % this.sequence.length;
			this.currentName = this.sequence[this.index].name;
			this.timeLeft = this.sequence[this.index].duration;
		}
	}
}

window.ModeTimer = ModeTimer;





import { EventEmitter } from 'events';

export interface QueueEvent {
    type: string;
    payload: any;
    timestamp: Date;
    source: string;
}

export interface JobEvent extends QueueEvent {
    jobId: string;
    workerId?: number;
}

export interface WorkerEvent extends QueueEvent {
    workerId: number;
}

export interface SessionEvent extends QueueEvent {
    sessionId: string;
    teamId: string;
}

export class QueueEventBus extends EventEmitter {
    private static instance: QueueEventBus;
    
    private constructor() {
        super();
        this.setMaxListeners(50); // Allow more listeners for distributed components
    }
    
    public static getInstance(): QueueEventBus {
        if (!QueueEventBus.instance) {
            QueueEventBus.instance = new QueueEventBus();
        }
        return QueueEventBus.instance;
    }
    
    // Job-related events
    public emitJobQueued(jobId: string, data: any, source: string = 'unknown'): void {
        this.emit('job:queued', this.createJobEvent('job:queued', jobId, data, source));
    }
    
    public emitJobStarted(jobId: string, workerId: number, data: any, source: string = 'unknown'): void {
        this.emit('job:started', this.createJobEvent('job:started', jobId, { ...data, workerId }, source));
    }
    
    public emitJobProgress(jobId: string, workerId: number, progress: any, source: string = 'unknown'): void {
        this.emit('job:progress', this.createJobEvent('job:progress', jobId, { progress, workerId }, source));
    }
    
    public emitJobCompleted(jobId: string, workerId: number, result: any, source: string = 'unknown'): void {
        this.emit('job:completed', this.createJobEvent('job:completed', jobId, { result, workerId }, source));
    }
    
    public emitJobFailed(jobId: string, workerId: number, error: any, source: string = 'unknown'): void {
        this.emit('job:failed', this.createJobEvent('job:failed', jobId, { error, workerId }, source));
    }
    
    public emitJobRetry(jobId: string, retryCount: number, error: any, source: string = 'unknown'): void {
        this.emit('job:retry', this.createJobEvent('job:retry', jobId, { retryCount, error }, source));
    }
    
    // Worker-related events
    public emitWorkerCreated(workerId: number, source: string = 'unknown'): void {
        this.emit('worker:created', this.createWorkerEvent('worker:created', workerId, {}, source));
    }
    
    public emitWorkerIdle(workerId: number, source: string = 'unknown'): void {
        this.emit('worker:idle', this.createWorkerEvent('worker:idle', workerId, {}, source));
    }
    
    public emitWorkerError(workerId: number, error: any, source: string = 'unknown'): void {
        this.emit('worker:error', this.createWorkerEvent('worker:error', workerId, { error }, source));
    }
    
    public emitWorkerTerminated(workerId: number, exitCode: number, source: string = 'unknown'): void {
        this.emit('worker:terminated', this.createWorkerEvent('worker:terminated', workerId, { exitCode }, source));
    }
    
    // Session-related events
    public emitSessionStarted(sessionId: string, teamId: string, data: any, source: string = 'unknown'): void {
        this.emit('session:started', this.createSessionEvent('session:started', sessionId, teamId, data, source));
    }
    
    public emitSessionCompleted(sessionId: string, teamId: string, data: any, source: string = 'unknown'): void {
        this.emit('session:completed', this.createSessionEvent('session:completed', sessionId, teamId, data, source));
    }
    
    // System events
    public emitSystemHealthCheck(metrics: any, source: string = 'unknown'): void {
        this.emit('system:health-check', this.createEvent('system:health-check', metrics, source));
    }
    
    public emitSystemOverloaded(loadData: any, source: string = 'unknown'): void {
        this.emit('system:overloaded', this.createEvent('system:overloaded', loadData, source));
    }
    
    // Helper methods for creating events
    private createJobEvent(type: string, jobId: string, payload: any, source: string): JobEvent {
        return {
            type,
            jobId,
            payload,
            timestamp: new Date(),
            source,
            workerId: payload.workerId
        };
    }
    
    private createWorkerEvent(type: string, workerId: number, payload: any, source: string): WorkerEvent {
        return {
            type,
            workerId,
            payload,
            timestamp: new Date(),
            source
        };
    }
    
    private createSessionEvent(type: string, sessionId: string, teamId: string, payload: any, source: string): SessionEvent {
        return {
            type,
            sessionId,
            teamId,
            payload,
            timestamp: new Date(),
            source
        };
    }
    
    private createEvent(type: string, payload: any, source: string): QueueEvent {
        return {
            type,
            payload,
            timestamp: new Date(),
            source
        };
    }
    
    // Convenience methods for subscribing to events
    public onJobQueued(listener: (event: JobEvent) => void): void {
        this.on('job:queued', listener);
    }
    
    public onJobStarted(listener: (event: JobEvent) => void): void {
        this.on('job:started', listener);
    }
    
    public onJobProgress(listener: (event: JobEvent) => void): void {
        this.on('job:progress', listener);
    }
    
    public onJobCompleted(listener: (event: JobEvent) => void): void {
        this.on('job:completed', listener);
    }
    
    public onJobFailed(listener: (event: JobEvent) => void): void {
        this.on('job:failed', listener);
    }
    
    public onJobRetry(listener: (event: JobEvent) => void): void {
        this.on('job:retry', listener);
    }
    
    public onWorkerCreated(listener: (event: WorkerEvent) => void): void {
        this.on('worker:created', listener);
    }
    
    public onWorkerIdle(listener: (event: WorkerEvent) => void): void {
        this.on('worker:idle', listener);
    }
    
    public onWorkerError(listener: (event: WorkerEvent) => void): void {
        this.on('worker:error', listener);
    }
    
    public onWorkerTerminated(listener: (event: WorkerEvent) => void): void {
        this.on('worker:terminated', listener);
    }
    
    public onSessionStarted(listener: (event: SessionEvent) => void): void {
        this.on('session:started', listener);
    }
    
    public onSessionCompleted(listener: (event: SessionEvent) => void): void {
        this.on('session:completed', listener);
    }
    
    public onSystemHealthCheck(listener: (event: QueueEvent) => void): void {
        this.on('system:health-check', listener);
    }
    
    public onSystemOverloaded(listener: (event: QueueEvent) => void): void {
        this.on('system:overloaded', listener);
    }
}
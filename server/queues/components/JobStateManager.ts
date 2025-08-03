import { BaseJob } from '@/types/queues/base-processing-queue';
import { QueueEventBus, JobEvent } from './QueueEventBus';

export interface JobState {
    jobId: string;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'retrying' | 'queued_after_failure';
    job: BaseJob;
    rawData: string;
    workerId?: number;
    startTime?: number;
    retries: number;
    sessionId?: string;
    teamId?: string;
    trajectoryId?: string;
    progress?: any;
    result?: any;
    error?: string;
    lastUpdated: Date;
}

export class JobStateManager {
    private static instance: JobStateManager;
    private jobStates = new Map<string, JobState>();
    private workerJobMap = new Map<number, string>(); // workerId -> jobId
    private eventBus: QueueEventBus;
    
    private constructor() {
        this.eventBus = QueueEventBus.getInstance();
        this.setupEventListeners();
    }
    
    public static getInstance(): JobStateManager {
        if (!JobStateManager.instance) {
            JobStateManager.instance = new JobStateManager();
        }
        return JobStateManager.instance;
    }
    
    private setupEventListeners(): void {
        this.eventBus.onJobQueued((event) => this.handleJobQueued(event));
        this.eventBus.onJobStarted((event) => this.handleJobStarted(event));
        this.eventBus.onJobProgress((event) => this.handleJobProgress(event));
        this.eventBus.onJobCompleted((event) => this.handleJobCompleted(event));
        this.eventBus.onJobFailed((event) => this.handleJobFailed(event));
        this.eventBus.onJobRetry((event) => this.handleJobRetry(event));
    }
    
    // Core job state management
    public addJob(job: BaseJob, rawData: string, sessionId?: string): void {
        const jobState: JobState = {
            jobId: job.jobId,
            status: 'queued',
            job,
            rawData,
            retries: job.retries || 0,
            sessionId,
            teamId: (job as any).teamId,
            trajectoryId: (job as any).trajectoryId,
            lastUpdated: new Date()
        };
        
        this.jobStates.set(job.jobId, jobState);
        this.eventBus.emitJobQueued(job.jobId, { job, sessionId }, 'JobStateManager');
    }
    
    public getJobState(jobId: string): JobState | undefined {
        return this.jobStates.get(jobId);
    }
    
    public getJobByWorkerId(workerId: number): JobState | undefined {
        const jobId = this.workerJobMap.get(workerId);
        return jobId ? this.jobStates.get(jobId) : undefined;
    }
    
    public getAllJobs(): JobState[] {
        return Array.from(this.jobStates.values());
    }
    
    public getJobsByStatus(status: JobState['status']): JobState[] {
        return this.getAllJobs().filter(job => job.status === status);
    }
    
    public getJobsBySession(sessionId: string): JobState[] {
        return this.getAllJobs().filter(job => job.sessionId === sessionId);
    }
    
    public removeJob(jobId: string): void {
        const jobState = this.jobStates.get(jobId);
        if (jobState && jobState.workerId) {
            this.workerJobMap.delete(jobState.workerId);
        }
        this.jobStates.delete(jobId);
    }
    
    public assignWorker(jobId: string, workerId: number): boolean {
        const jobState = this.jobStates.get(jobId);
        if (!jobState) {
            return false;
        }
        
        jobState.workerId = workerId;
        jobState.startTime = Date.now();
        jobState.status = 'running';
        jobState.lastUpdated = new Date();
        
        this.workerJobMap.set(workerId, jobId);
        
        this.eventBus.emitJobStarted(jobId, workerId, {
            job: jobState.job,
            startTime: jobState.startTime,
            teamId: jobState.teamId,
            trajectoryId: jobState.trajectoryId
        }, 'JobStateManager');
        
        return true;
    }
    
    public releaseWorker(workerId: number): string | undefined {
        const jobId = this.workerJobMap.get(workerId);
        if (jobId) {
            const jobState = this.jobStates.get(jobId);
            if (jobState) {
                jobState.workerId = undefined;
                jobState.startTime = undefined;
                jobState.lastUpdated = new Date();
            }
            this.workerJobMap.delete(workerId);
        }
        return jobId;
    }
    
    // Event handlers
    private handleJobQueued(event: JobEvent): void {
        // Job already added via addJob method
    }
    
    private handleJobStarted(event: JobEvent): void {
        const jobState = this.jobStates.get(event.jobId);
        if (jobState && event.workerId) {
            jobState.status = 'running';
            jobState.workerId = event.workerId;
            jobState.startTime = Date.now();
            jobState.lastUpdated = new Date();
        }
    }
    
    private handleJobProgress(event: JobEvent): void {
        const jobState = this.jobStates.get(event.jobId);
        if (jobState) {
            jobState.progress = event.payload.progress;
            jobState.lastUpdated = new Date();
        }
    }
    
    private handleJobCompleted(event: JobEvent): void {
        const jobState = this.jobStates.get(event.jobId);
        if (jobState) {
            jobState.status = 'completed';
            jobState.result = event.payload.result;
            jobState.lastUpdated = new Date();
        }
    }
    
    private handleJobFailed(event: JobEvent): void {
        const jobState = this.jobStates.get(event.jobId);
        if (jobState) {
            jobState.status = 'failed';
            jobState.error = event.payload.error;
            jobState.lastUpdated = new Date();
        }
    }
    
    private handleJobRetry(event: JobEvent): void {
        const jobState = this.jobStates.get(event.jobId);
        if (jobState) {
            jobState.status = 'retrying';
            jobState.retries = event.payload.retryCount;
            jobState.error = event.payload.error;
            jobState.lastUpdated = new Date();
        }
    }
    
    // Utility methods
    public getMetrics(): {
        totalJobs: number;
        queuedJobs: number;
        runningJobs: number;
        completedJobs: number;
        failedJobs: number;
        retryingJobs: number;
    } {
        const jobs = this.getAllJobs();
        return {
            totalJobs: jobs.length,
            queuedJobs: jobs.filter(j => j.status === 'queued').length,
            runningJobs: jobs.filter(j => j.status === 'running').length,
            completedJobs: jobs.filter(j => j.status === 'completed').length,
            failedJobs: jobs.filter(j => j.status === 'failed').length,
            retryingJobs: jobs.filter(j => j.status === 'retrying').length
        };
    }
    
    public cleanup(): void {
        this.jobStates.clear();
        this.workerJobMap.clear();
    }
}
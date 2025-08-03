import { BaseJob } from '@/types/queues/base-processing-queue';
import { QueueEventBus, JobEvent } from './QueueEventBus';
import { JobStateManager, JobState } from './JobStateManager';

export interface RetryConfig {
    maxRetries: number;
    retryDelay: number;
    backoffMultiplier: number;
    maxRetryDelay: number;
}

export class JobLifecycleManager {
    private static instance: JobLifecycleManager;
    
    private eventBus: QueueEventBus;
    private jobStateManager: JobStateManager;
    private retryConfig: RetryConfig;
    
    private constructor(retryConfig: RetryConfig) {
        this.eventBus = QueueEventBus.getInstance();
        this.jobStateManager = JobStateManager.getInstance();
        this.retryConfig = retryConfig;
        this.setupEventListeners();
    }
    
    public static getInstance(retryConfig?: RetryConfig): JobLifecycleManager {
        if (!JobLifecycleManager.instance) {
            const defaultConfig: RetryConfig = {
                maxRetries: 3,
                retryDelay: 1000,
                backoffMultiplier: 2,
                maxRetryDelay: 30000
            };
            JobLifecycleManager.instance = new JobLifecycleManager(retryConfig || defaultConfig);
        }
        return JobLifecycleManager.instance;
    }
    
    private setupEventListeners(): void {
        this.eventBus.onJobCompleted((event) => this.handleJobCompleted(event));
        this.eventBus.onJobFailed((event) => this.handleJobFailed(event));
    }
    
    // Job lifecycle management
    public startJob(jobId: string, workerId: number): boolean {
        const jobState = this.jobStateManager.getJobState(jobId);
        if (!jobState) {
            console.error(`[JobLifecycleManager] Job ${jobId} not found`);
            return false;
        }
        
        return this.jobStateManager.assignWorker(jobId, workerId);
    }
    
    public updateJobProgress(jobId: string, workerId: number, progress: any): void {
        const jobState = this.jobStateManager.getJobState(jobId);
        if (!jobState || jobState.workerId !== workerId) {
            console.warn(`[JobLifecycleManager] Invalid progress update for job ${jobId} from worker ${workerId}`);
            return;
        }
        
        this.eventBus.emitJobProgress(jobId, workerId, progress, 'JobLifecycleManager');
    }
    
    public completeJob(jobId: string, workerId: number, result: any): void {
        const jobState = this.jobStateManager.getJobState(jobId);
        if (!jobState || jobState.workerId !== workerId) {
            console.warn(`[JobLifecycleManager] Invalid completion for job ${jobId} from worker ${workerId}`);
            return;
        }
        
        this.eventBus.emitJobCompleted(jobId, workerId, result, 'JobLifecycleManager');
    }
    
    public failJob(jobId: string, workerId: number, error: string): void {
        const jobState = this.jobStateManager.getJobState(jobId);
        if (!jobState || jobState.workerId !== workerId) {
            console.warn(`[JobLifecycleManager] Invalid failure for job ${jobId} from worker ${workerId}`);
            return;
        }
        
        this.eventBus.emitJobFailed(jobId, workerId, error, 'JobLifecycleManager');
    }
    
    public timeoutJob(jobId: string, workerId: number): void {
        console.warn(`[JobLifecycleManager] Job ${jobId} timed out on worker ${workerId}`);
        this.failJob(jobId, workerId, `Job timed out on worker ${workerId}`);
    }
    
    // Event handlers
    private handleJobCompleted(event: JobEvent): void {
        const jobState = this.jobStateManager.getJobState(event.jobId);
        if (!jobState) return;
        
        console.log(`[JobLifecycleManager] Job ${event.jobId} completed successfully`);
        
        // Release the worker
        if (event.workerId) {
            this.jobStateManager.releaseWorker(event.workerId);
        }
        
        // Check if this completes a session
        this.checkSessionCompletion(jobState);
    }
    
    private handleJobFailed(event: JobEvent): void {
        const jobState = this.jobStateManager.getJobState(event.jobId);
        if (!jobState) return;
        
        const shouldRetry = this.shouldRetryJob(jobState);
        
        if (shouldRetry) {
            this.retryJob(jobState, event.payload.error);
        } else {
            console.error(`[JobLifecycleManager] Job ${event.jobId} failed permanently: ${event.payload.error}`);
            
            // Release the worker
            if (event.workerId) {
                this.jobStateManager.releaseWorker(event.workerId);
            }
            
            // Check if this affects session completion
            this.checkSessionCompletion(jobState);
        }
    }
    
    private shouldRetryJob(jobState: JobState): boolean {
        const maxRetries = jobState.job.maxRetries || this.retryConfig.maxRetries;
        return jobState.retries < maxRetries;
    }
    
    private retryJob(jobState: JobState, error: string): void {
        const retryCount = jobState.retries + 1;
        const delay = this.calculateRetryDelay(retryCount);
        
        console.log(`[JobLifecycleManager] Retrying job ${jobState.jobId} (attempt ${retryCount}/${jobState.job.maxRetries || this.retryConfig.maxRetries}) after ${delay}ms`);
        
        // Release the current worker
        if (jobState.workerId) {
            this.jobStateManager.releaseWorker(jobState.workerId);
        }
        
        // Schedule retry
        setTimeout(() => {
            const retryJob = { ...jobState.job, retries: retryCount };
            
            // Update job state with retry information
            const updatedJobState = this.jobStateManager.getJobState(jobState.jobId);
            if (updatedJobState) {
                updatedJobState.job = retryJob;
                updatedJobState.retries = retryCount;
                updatedJobState.status = 'retrying';
                updatedJobState.lastUpdated = new Date();
            }
            
            this.eventBus.emitJobRetry(jobState.jobId, retryCount, error, 'JobLifecycleManager');
            
            // Re-queue the job for processing
            this.requeueJob(retryJob, jobState.rawData);
        }, delay);
    }
    
    private calculateRetryDelay(retryCount: number): number {
        const baseDelay = this.retryConfig.retryDelay;
        const multiplier = Math.pow(this.retryConfig.backoffMultiplier, retryCount - 1);
        const delay = baseDelay * multiplier;
        
        return Math.min(delay, this.retryConfig.maxRetryDelay);
    }
    
    private requeueJob(job: BaseJob, rawData: string): void {
        // This would trigger re-adding the job to the queue
        // The specific implementation depends on how jobs are queued
        this.eventBus.emit('job:requeue', {
            type: 'job:requeue',
            jobId: job.jobId,
            payload: { job, rawData },
            timestamp: new Date(),
            source: 'JobLifecycleManager'
        });
    }
    
    private checkSessionCompletion(jobState: JobState): void {
        if (!jobState.sessionId || !jobState.teamId) {
            return;
        }
        
        // This could be enhanced to check if all jobs in a session are complete
        // For now, emit an event that can be handled by a session manager
        this.eventBus.emit('session:job-completed', {
            type: 'session:job-completed',
            payload: {
                sessionId: jobState.sessionId,
                teamId: jobState.teamId,
                trajectoryId: jobState.trajectoryId,
                jobId: jobState.jobId,
                status: jobState.status
            },
            timestamp: new Date(),
            source: 'JobLifecycleManager'
        });
    }
    
    // Utility methods
    public getJobProcessingTime(jobId: string): number | null {
        const jobState = this.jobStateManager.getJobState(jobId);
        if (!jobState || !jobState.startTime) {
            return null;
        }
        
        return Date.now() - jobState.startTime;
    }
    
    public isJobTimeout(jobId: string, timeoutMs: number): boolean {
        const processingTime = this.getJobProcessingTime(jobId);
        return processingTime !== null && processingTime > timeoutMs;
    }
    
    public getActiveJobs(): JobState[] {
        return this.jobStateManager.getJobsByStatus('running');
    }
    
    public getMetrics(): {
        totalJobs: number;
        completedJobs: number;
        failedJobs: number;
        retryingJobs: number;
        averageProcessingTime: number;
    } {
        const allJobs = this.jobStateManager.getAllJobs();
        const completedJobs = allJobs.filter(job => job.status === 'completed');
        const failedJobs = allJobs.filter(job => job.status === 'failed');
        const retryingJobs = allJobs.filter(job => job.status === 'retrying');
        
        const processingTimes = completedJobs
            .filter(job => job.startTime)
            .map(job => (job.lastUpdated.getTime() - job.startTime!));
        
        const averageProcessingTime = processingTimes.length > 0
            ? processingTimes.reduce((sum, time) => sum + time, 0) / processingTimes.length
            : 0;
        
        return {
            totalJobs: allJobs.length,
            completedJobs: completedJobs.length,
            failedJobs: failedJobs.length,
            retryingJobs: retryingJobs.length,
            averageProcessingTime
        };
    }
}
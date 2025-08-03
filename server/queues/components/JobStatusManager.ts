import { redis } from '@config/redis';
import { emitJobUpdate } from '@/config/socket';
import { QueueEventBus, JobEvent } from './QueueEventBus';
import { JobStateManager } from './JobStateManager';

export interface JobStatusData {
    jobId: string;
    status: string;
    sessionId?: string;
    sessionStartTime?: string;
    trajectoryId?: string;
    name?: string;
    message?: string;
    timestamp: string;
    teamId?: string;
    chunkIndex?: number;
    totalChunks?: number;
    progress?: any;
    result?: any;
    error?: string;
    processingTimeMs?: number;
    workerId?: number;
    startTime?: string;
    retries?: number;
    maxRetries?: number;
    finalAttempt?: boolean;
}

export class JobStatusManager {
    private static instance: JobStatusManager;
    
    private eventBus: QueueEventBus;
    private jobStateManager: JobStateManager;
    private statusKeyPrefix: string;
    
    private constructor(statusKeyPrefix: string) {
        this.eventBus = QueueEventBus.getInstance();
        this.jobStateManager = JobStateManager.getInstance();
        this.statusKeyPrefix = statusKeyPrefix;
        this.setupEventListeners();
    }
    
    public static getInstance(statusKeyPrefix?: string): JobStatusManager {
        if (!JobStatusManager.instance) {
            if (!statusKeyPrefix) {
                throw new Error('JobStatusManager requires statusKeyPrefix for initialization');
            }
            JobStatusManager.instance = new JobStatusManager(statusKeyPrefix);
        }
        return JobStatusManager.instance;
    }
    
    private setupEventListeners(): void {
        this.eventBus.onJobQueued((event) => this.handleJobQueued(event));
        this.eventBus.onJobStarted((event) => this.handleJobStarted(event));
        this.eventBus.onJobProgress((event) => this.handleJobProgress(event));
        this.eventBus.onJobCompleted((event) => this.handleJobCompleted(event));
        this.eventBus.onJobFailed((event) => this.handleJobFailed(event));
        this.eventBus.onJobRetry((event) => this.handleJobRetry(event));
    }
    
    // Core status management
    public async setJobStatus(jobId: string, status: string, data: Partial<JobStatusData> = {}): Promise<void> {
        const jobState = this.jobStateManager.getJobState(jobId);
        let existingJobData: JobStatusData | null = null;
        
        try {
            const existingJobStatusString = await redis!.get(`${this.statusKeyPrefix}${jobId}`);
            if (existingJobStatusString) {
                existingJobData = JSON.parse(existingJobStatusString);
            }
        } catch (error) {
            console.log(`Could not retrieve existing job data for ${jobId}:`, error);
        }
        
        const statusData: JobStatusData = {
            jobId,
            status,
            timestamp: new Date().toISOString(),
            sessionId: data.sessionId || existingJobData?.sessionId || jobState?.sessionId,
            sessionStartTime: data.sessionStartTime || existingJobData?.sessionStartTime,
            trajectoryId: data.trajectoryId || existingJobData?.trajectoryId || jobState?.trajectoryId,
            name: data.name || existingJobData?.name || jobState?.job.name,
            message: data.message || existingJobData?.message || jobState?.job.message,
            teamId: data.teamId || existingJobData?.teamId || jobState?.teamId,
            chunkIndex: data.chunkIndex !== undefined ? data.chunkIndex : existingJobData?.chunkIndex,
            totalChunks: data.totalChunks !== undefined ? data.totalChunks : existingJobData?.totalChunks,
            ...data
        };
        
        try {
            const pipeline = redis!.pipeline();
            
            // Store job status with 30-day expiration
            pipeline.setex(
                `${this.statusKeyPrefix}${jobId}`,
                86400 * 30,
                JSON.stringify(statusData)
            );
            
            // Add to team jobs set if teamId is available
            if (statusData.teamId) {
                const teamJobsKey = `team:${statusData.teamId}:jobs`;
                pipeline.sadd(teamJobsKey, jobId);
                pipeline.expire(teamJobsKey, 86400 * 30);
            }
            
            await pipeline.exec();
            
            // Emit socket update to team
            if (statusData.teamId) {
                this.emitStatusUpdate(statusData);
            }
            
        } catch (err) {
            console.error(`[JobStatusManager] Failed to set job status for ${jobId}:`, err);
        }
    }
    
    public async getJobStatus(jobId: string): Promise<JobStatusData | null> {
        try {
            const statusData = await redis!.get(`${this.statusKeyPrefix}${jobId}`);
            return statusData ? JSON.parse(statusData) : null;
        } catch (error) {
            console.error(`[JobStatusManager] Failed to get job status for ${jobId}:`, error);
            return null;
        }
    }
    
    public async getJobsForTeam(teamId: string): Promise<JobStatusData[]> {
        try {
            const teamJobsKey = `team:${teamId}:jobs`;
            const jobIds = await redis!.smembers(teamJobsKey);
            
            if (jobIds.length === 0) {
                return [];
            }
            
            const pipeline = redis!.pipeline();
            jobIds.forEach(jobId => {
                pipeline.get(`${this.statusKeyPrefix}${jobId}`);
            });
            
            const results = await pipeline.exec();
            const jobs: JobStatusData[] = [];
            
            if (results) {
                results.forEach((result, index) => {
                    if (result && result[1] && typeof result[1] === 'string') {
                        try {
                            const jobData = JSON.parse(result[1]);
                            jobs.push(jobData);
                        } catch (error) {
                            console.error(`Failed to parse job data for ${jobIds[index]}:`, error);
                        }
                    }
                });
            }
            
            // Sort by timestamp (newest first)
            return jobs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
            
        } catch (error) {
            console.error(`[JobStatusManager] Failed to get jobs for team ${teamId}:`, error);
            return [];
        }
    }
    
    private emitStatusUpdate(statusData: JobStatusData): void {
        try {
            emitJobUpdate(statusData.teamId!, statusData);
        } catch (error) {
            console.error(`[JobStatusManager] Failed to emit status update:`, error);
        }
    }
    
    // Event handlers
    private async handleJobQueued(event: JobEvent): void {
        await this.setJobStatus(event.jobId, 'queued', {
            sessionId: event.payload.sessionId,
            teamId: event.payload.job.teamId,
            trajectoryId: (event.payload.job as any).trajectoryId,
            name: event.payload.job.name,
            message: event.payload.job.message,
            chunkIndex: (event.payload.job as any).chunkIndex,
            totalChunks: (event.payload.job as any).totalChunks
        });
    }
    
    private async handleJobStarted(event: JobEvent): void {
        await this.setJobStatus(event.jobId, 'running', {
            workerId: event.workerId,
            startTime: new Date(event.payload.startTime).toISOString(),
            teamId: event.payload.teamId,
            trajectoryId: event.payload.trajectoryId
        });
    }
    
    private async handleJobProgress(event: JobEvent): void {
        const processingTime = this.calculateProcessingTime(event.jobId);
        
        await this.setJobStatus(event.jobId, 'running', {
            progress: event.payload.progress,
            processingTimeMs: processingTime
        });
    }
    
    private async handleJobCompleted(event: JobEvent): void {
        const processingTime = this.calculateProcessingTime(event.jobId);
        
        await this.setJobStatus(event.jobId, 'completed', {
            result: event.payload.result,
            processingTimeMs: processingTime
        });
    }
    
    private async handleJobFailed(event: JobEvent): void {
        const processingTime = this.calculateProcessingTime(event.jobId);
        const jobState = this.jobStateManager.getJobState(event.jobId);
        
        await this.setJobStatus(event.jobId, 'failed', {
            error: event.payload.error,
            processingTimeMs: processingTime,
            finalAttempt: true,
            retries: jobState?.retries || 0,
            maxRetries: jobState?.job.maxRetries || 3
        });
    }
    
    private async handleJobRetry(event: JobEvent): void {
        const processingTime = this.calculateProcessingTime(event.jobId);
        const jobState = this.jobStateManager.getJobState(event.jobId);
        
        await this.setJobStatus(event.jobId, 'retrying', {
            error: event.payload.error,
            retries: event.payload.retryCount,
            maxRetries: jobState?.job.maxRetries || 3,
            processingTimeMs: processingTime
        });
    }
    
    private calculateProcessingTime(jobId: string): number | undefined {
        const jobState = this.jobStateManager.getJobState(jobId);
        if (!jobState || !jobState.startTime) {
            return undefined;
        }
        
        return Date.now() - jobState.startTime;
    }
    
    // Cleanup methods
    public async cleanupJobStatus(jobId: string): Promise<void> {
        try {
            await redis!.del(`${this.statusKeyPrefix}${jobId}`);
        } catch (error) {
            console.error(`[JobStatusManager] Failed to cleanup job status for ${jobId}:`, error);
        }
    }
    
    public async cleanupTeamJobs(teamId: string, jobIds: string[]): Promise<void> {
        try {
            const pipeline = redis!.pipeline();
            const teamJobsKey = `team:${teamId}:jobs`;
            
            jobIds.forEach(jobId => {
                pipeline.del(`${this.statusKeyPrefix}${jobId}`);
                pipeline.srem(teamJobsKey, jobId);
            });
            
            await pipeline.exec();
        } catch (error) {
            console.error(`[JobStatusManager] Failed to cleanup team jobs for ${teamId}:`, error);
        }
    }
    
    // Metrics and monitoring
    public async getStatusMetrics(): Promise<{
        totalJobsTracked: number;
        jobsByStatus: Record<string, number>;
    }> {
        const allJobs = this.jobStateManager.getAllJobs();
        const jobsByStatus: Record<string, number> = {};
        
        allJobs.forEach(job => {
            jobsByStatus[job.status] = (jobsByStatus[job.status] || 0) + 1;
        });
        
        return {
            totalJobsTracked: allJobs.length,
            jobsByStatus
        };
    }
}
import { WorkerPoolItem } from '@/types/queues/base-processing-queue';
import { Worker } from 'worker_threads';
import { QueueEventBus, WorkerEvent } from './QueueEventBus';

export interface WorkerPoolConfig {
    workerPath: string;
    maxWorkers: number;
    workerIdleTimeout: number;
    cleanupInterval: number;
}

export class WorkerPoolManager {
    private static instances = new Map<string, WorkerPoolManager>();
    
    private workerPool: WorkerPoolItem[] = [];
    private config: WorkerPoolConfig;
    private eventBus: QueueEventBus;
    private cleanupInterval: NodeJS.Timeout | null = null;
    private isShutdown = false;
    
    private constructor(config: WorkerPoolConfig) {
        this.config = config;
        this.eventBus = QueueEventBus.getInstance();
        this.setupEventListeners();
        this.initializePool();
        this.startCleanup();
    }
    
    public static getInstance(poolId: string, config?: WorkerPoolConfig): WorkerPoolManager {
        if (!WorkerPoolManager.instances.has(poolId)) {
            if (!config) {
                throw new Error(`WorkerPoolManager config required for new pool: ${poolId}`);
            }
            WorkerPoolManager.instances.set(poolId, new WorkerPoolManager(config));
        }
        return WorkerPoolManager.instances.get(poolId)!;
    }
    
    private setupEventListeners(): void {
        this.eventBus.onWorkerError((event) => this.handleWorkerError(event));
        this.eventBus.onWorkerTerminated((event) => this.handleWorkerTerminated(event));
    }
    
    private initializePool(): void {
        console.log(`[WorkerPoolManager] Initializing pool with ${this.config.maxWorkers} workers`);
        
        for (let i = 0; i < this.config.maxWorkers; i++) {
            this.workerPool.push(this.createWorkerItem());
        }
    }
    
    private createWorkerItem(): WorkerPoolItem {
        const worker = this.createWorker();
        const workerItem: WorkerPoolItem = {
            worker,
            isIdle: true,
            jobCount: 0,
            lastUsed: Date.now(),
            timeouts: new Set()
        };
        
        this.eventBus.emitWorkerCreated(worker.threadId, 'WorkerPoolManager');
        return workerItem;
    }
    
    private createWorker(): Worker {
        const worker = new Worker(this.config.workerPath, {
            execArgv: ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register']
        });
        
        worker.on('error', (err) => {
            this.eventBus.emitWorkerError(worker.threadId, err, 'WorkerPoolManager');
        });
        
        worker.on('exit', (code) => {
            this.eventBus.emitWorkerTerminated(worker.threadId, code, 'WorkerPoolManager');
        });
        
        return worker;
    }
    
    // Public API for worker management
    public getAvailableWorker(): WorkerPoolItem | undefined {
        const idleWorkers = this.workerPool.filter(item => item.isIdle);
        
        if (idleWorkers.length === 0) {
            return undefined;
        }
        
        // Return the best available worker (least used, least recently used)
        return idleWorkers.reduce((best, current) => {
            if (current.jobCount < best.jobCount) return current;
            if (current.jobCount === best.jobCount && current.lastUsed < best.lastUsed) return current;
            return best;
        });
    }
    
    public assignWorker(workerId: number, jobId: string): boolean {
        const workerItem = this.workerPool.find(item => item.worker.threadId === workerId);
        if (!workerItem || !workerItem.isIdle) {
            return false;
        }
        
        workerItem.isIdle = false;
        workerItem.currentJobId = jobId;
        workerItem.startTime = Date.now();
        workerItem.lastUsed = Date.now();
        
        return true;
    }
    
    public releaseWorker(workerId: number): void {
        const workerItem = this.workerPool.find(item => item.worker.threadId === workerId);
        if (workerItem) {
            this.clearWorkerTimeouts(workerItem);
            workerItem.isIdle = true;
            workerItem.currentJobId = undefined;
            workerItem.startTime = undefined;
            workerItem.lastUsed = Date.now();
            workerItem.jobCount++;
            
            this.eventBus.emitWorkerIdle(workerId, 'WorkerPoolManager');
        }
    }
    
    public getWorkerItem(workerId: number): WorkerPoolItem | undefined {
        return this.workerPool.find(item => item.worker.threadId === workerId);
    }
    
    public addTimeout(workerId: number, timeout: NodeJS.Timeout): void {
        const workerItem = this.getWorkerItem(workerId);
        if (workerItem) {
            workerItem.timeouts.add(timeout);
        }
    }
    
    public clearWorkerTimeouts(workerItem: WorkerPoolItem): void {
        for (const timeout of workerItem.timeouts) {
            clearTimeout(timeout);
        }
        workerItem.timeouts.clear();
    }
    
    private handleWorkerError(event: WorkerEvent): void {
        console.error(`[WorkerPoolManager] Worker #${event.workerId} error:`, event.payload.error);
        this.replaceWorker(event.workerId);
    }
    
    private handleWorkerTerminated(event: WorkerEvent): void {
        const exitCode = event.payload.exitCode;
        console.log(`[WorkerPoolManager] Worker #${event.workerId} exited with code ${exitCode}`);
        
        if (exitCode !== 0) {
            console.warn(`[WorkerPoolManager] Worker #${event.workerId} exited unexpectedly`);
        }
        
        this.replaceWorker(event.workerId);
    }
    
    private replaceWorker(workerId: number): void {
        const workerIndex = this.workerPool.findIndex(item => item.worker.threadId === workerId);
        
        if (workerIndex !== -1) {
            const oldWorker = this.workerPool[workerIndex];
            this.clearWorkerTimeouts(oldWorker);
            
            // Terminate the old worker if it's still running
            oldWorker.worker.terminate().catch(() => {
                // Ignore termination errors
            });
            
            // Create a new worker
            this.workerPool[workerIndex] = this.createWorkerItem();
            
            console.log(`[WorkerPoolManager] Replaced worker #${workerId} with new worker #${this.workerPool[workerIndex].worker.threadId}`);
        }
    }
    
    private startCleanup(): void {
        this.cleanupInterval = setInterval(() => {
            this.performCleanup();
        }, this.config.cleanupInterval);
    }
    
    private performCleanup(): void {
        if (this.isShutdown || this.workerPool.length <= 1) {
            return;
        }
        
        const now = Date.now();
        const workersToRemove: number[] = [];
        
        for (let i = 0; i < this.workerPool.length; i++) {
            const item = this.workerPool[i];
            if (item.isIdle && (now - item.lastUsed) > this.config.workerIdleTimeout) {
                workersToRemove.push(i);
            }
        }
        
        // Keep at least one worker
        if (workersToRemove.length > 0 && this.workerPool.length - workersToRemove.length >= 1) {
            for (let i = workersToRemove.length - 1; i >= 0; i--) {
                const index = workersToRemove[i];
                const item = this.workerPool[index];
                this.clearWorkerTimeouts(item);
                item.worker.terminate().catch(() => {});
                this.workerPool.splice(index, 1);
            }
            console.log(`[WorkerPoolManager] Cleaned up ${workersToRemove.length} idle workers`);
        }
    }
    
    // Status and metrics
    public getStatus(): {
        totalWorkers: number;
        idleWorkers: number;
        activeWorkers: number;
        workers: Array<{
            threadId: number;
            isIdle: boolean;
            currentJobId?: string;
            jobCount: number;
            lastUsed: number;
        }>;
    } {
        const idleWorkers = this.workerPool.filter(item => item.isIdle).length;
        
        return {
            totalWorkers: this.workerPool.length,
            idleWorkers,
            activeWorkers: this.workerPool.length - idleWorkers,
            workers: this.workerPool.map(item => ({
                threadId: item.worker.threadId,
                isIdle: item.isIdle,
                currentJobId: item.currentJobId,
                jobCount: item.jobCount,
                lastUsed: item.lastUsed
            }))
        };
    }
    
    public async shutdown(): Promise<void> {
        console.log('[WorkerPoolManager] Starting shutdown...');
        
        this.isShutdown = true;
        
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        
        // Terminate all workers
        const terminatePromises = this.workerPool.map(item => {
            this.clearWorkerTimeouts(item);
            return item.worker.terminate().catch(() => {});
        });
        
        await Promise.allSettled(terminatePromises);
        this.workerPool = [];
        
        console.log('[WorkerPoolManager] Shutdown complete');
    }
}
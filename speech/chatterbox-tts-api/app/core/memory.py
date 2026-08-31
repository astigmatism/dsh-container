"""
Memory management utilities for TTS processing
"""

import gc
import torch
import psutil


def get_memory_info():
    """Get current memory usage information"""
    memory_info = {}
    
    # CPU memory
    process = psutil.Process()
    memory_info['cpu_memory_mb'] = process.memory_info().rss / 1024 / 1024
    memory_info['cpu_memory_percent'] = process.memory_percent()
    
    # GPU memory (if available)
    if torch.cuda.is_available():
        memory_info['gpu_memory_allocated_mb'] = torch.cuda.memory_allocated() / 1024 / 1024
        memory_info['gpu_memory_reserved_mb'] = torch.cuda.memory_reserved() / 1024 / 1024
        memory_info['gpu_memory_max_allocated_mb'] = torch.cuda.max_memory_allocated() / 1024 / 1024
    
    return memory_info


def cleanup_memory(force_cuda_clear=False):
    """Perform memory cleanup operations"""
    try:
        # Python garbage collection
        collected = gc.collect()
        
        # Clear PyTorch cache if using CUDA
        if torch.cuda.is_available() and force_cuda_clear:
            torch.cuda.empty_cache()
            torch.cuda.synchronize()
            print(f"🧹 CUDA cache cleared (collected {collected} objects)")
        elif collected > 0:
            print(f"🧹 Memory cleanup (collected {collected} objects)")
            
        return collected
            
    except Exception as e:
        print(f"⚠️ Memory cleanup warning: {e}")
        return 0


def safe_delete_tensors(*tensors):
    """Safely delete tensors and free memory"""
    for tensor in tensors:
        if tensor is not None:
            try:
                if hasattr(tensor, 'cpu'):
                    # Move to CPU first to free GPU memory
                    tensor = tensor.cpu()
                del tensor
            except Exception as e:
                print(f"⚠️ Warning during tensor cleanup: {e}") 
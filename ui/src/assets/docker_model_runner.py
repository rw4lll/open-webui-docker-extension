"""
title: Docker Model Runner Pipeline
author: Sergei Shitikov
author_url: https://github.com/rw4lll
project_url: https://github.com/rw4lll/open-webui-functions
version: 1.0.0
license: MIT
description: A manifold pipeline for interacting with Docker Model Runner models, providing OpenAI-compatible model endpoints.
features:
  - Dynamic model discovery from Docker Model Runner services
  - OpenAI-compatible API endpoints
  - Support for chat completions, embeddings, and standard completions
  - Automatic image content filtering (images not supported)
  - Configurable base URL and connection settings
  - Error handling and retry logic
  - Streaming response support
  - Model caching for improved performance
"""

import os
import time
import json
import requests
from typing import List, Union, Generator, Iterator, Optional, Dict, Any
from pydantic import BaseModel, Field


class Pipe:
    """
    Pipeline for interacting with Docker Model Runner services.
    """

    class Valves(BaseModel):
        DMR_BASE_URL: str = Field(
            default=os.getenv("DMR_BASE_URL", "http://model-runner.docker.internal"),
            description="Base URL for the Docker Model Runner service.",
        )
        DMR_ENGINE_SUFFIX: str = Field(
            default="/engines/llama.cpp/v1",
            description="Engine suffix to append to the base URL for OpenAI-compatible endpoints.",
        )
        MODEL_CACHE_TTL: int = Field(
            default=int(os.getenv("DMR_MODEL_CACHE_TTL", "300")),
            description="Time in seconds to cache the model list before refreshing (seconds)",
        )
        CONNECTION_TIMEOUT: int = Field(
            default=int(os.getenv("DMR_CONNECTION_TIMEOUT", "30")),
            description="Connection timeout for API requests (seconds)",
        )
        RETRY_COUNT: int = Field(
            default=int(os.getenv("DMR_RETRY_COUNT", "2")),
            description="Number of times to retry API calls on temporary failures",
        )

    def __init__(self):
        """Initialize the Docker Model Runner pipeline."""
        self.type = "manifold"
        self.id = "docker_model_runner"
        self.name = "Docker Model Runner: "
        self.valves = self.Valves()
        
        # Model cache
        self._model_cache: Optional[List[Dict[str, str]]] = None
        self._model_cache_time: float = 0

    def get_dmr_url(self) -> str:
        """Get the full URL with engine suffix for OpenAI-compatible endpoints."""
        base_url = self.valves.DMR_BASE_URL.rstrip("/")
        if not base_url.endswith(self.valves.DMR_ENGINE_SUFFIX):
            base_url += self.valves.DMR_ENGINE_SUFFIX
        return base_url
    
    def get_dmr_models(self, force_refresh: bool = False) -> List[Dict[str, str]]:
        """
        Retrieve available Docker Model Runner models.
        Uses caching to reduce API calls.
        """
        # Check cache first
        current_time = time.time()
        if (
            not force_refresh
            and self._model_cache is not None
            and (current_time - self._model_cache_time) < self.valves.MODEL_CACHE_TTL
        ):
            return self._model_cache

        try:
            url = f"{self.get_dmr_url()}/models"
            response = requests.get(url, timeout=self.valves.CONNECTION_TIMEOUT)
            response.raise_for_status()
            
            data = response.json()
            available_models = []
            
            if isinstance(data, dict) and "data" in data:
                # OpenAI format response
                for model in data["data"]:
                    available_models.append({
                        "id": model.get("id", "unknown"),
                        "name": model.get("id", "unknown"),
                    })
            elif isinstance(data, list):
                # List format response
                for model in data:
                    if isinstance(model, str):
                        available_models.append({"id": model, "name": model})
                    elif isinstance(model, dict):
                        available_models.append({
                            "id": model.get("id", str(model)),
                            "name": model.get("name", model.get("id", str(model))),
                        })
            
            # Update cache
            self._model_cache = available_models
            self._model_cache_time = current_time
            return available_models

        except Exception as e:
            print(f"Could not fetch models from Docker Model Runner: {e}")
            return [{"id": "error", "name": f"Could not fetch models: {str(e)}"}]

    def pipes(self) -> List[Dict[str, str]]:
        """
        Returns a list of available Docker Model Runner models for the UI.
        """
        return self.get_dmr_models()

    def process_model_id(self, model_id: str) -> str:
        """
        Prepare and validate the model ID for use with the API.
        Strip any pipeline prefixes if present.
        """
        # Remove any pipeline prefix (e.g., "docker_model_runner.model_name" -> "model_name")
        if "." in model_id:
            model_id = model_id.split(".", 1)[-1]
        
        return model_id

    def process_messages(self, messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Process messages to remove image content since Docker Model Runner doesn't support images.
        """
        processed_messages = []
        
        for message in messages:
            processed_message = {"role": message.get("role", "user")}
            content = message.get("content", "")
            
            if isinstance(content, list):
                # Handle multimodal content - extract only text parts
                text_parts = []
                for item in content:
                    if item.get("type") == "text":
                        text_parts.append(item.get("text", ""))
                    elif item.get("type") == "image_url":
                        # Skip image content and add a note
                        text_parts.append("[Image content removed - not supported by Docker Model Runner]")
                
                processed_message["content"] = " ".join(text_parts).strip()
            else:
                # Handle plain text content
                processed_message["content"] = str(content)
            
            # Only add messages with content
            if processed_message["content"]:
                processed_messages.append(processed_message)
        
        return processed_messages

    def stream_response(self, url: str, headers: Dict[str, str], payload: Dict[str, Any]) -> Generator:
        """Handle streaming response from Docker Model Runner."""
        for attempt in range(self.valves.RETRY_COUNT + 1):
            try:
                with requests.post(
                    url, 
                    headers=headers, 
                    json=payload, 
                    stream=True, 
                    timeout=(3.05, 60)
                ) as response:
                    if response.status_code != 200:
                        raise Exception(f"HTTP Error {response.status_code}: {response.text}")

                    for line in response.iter_lines():
                        if line:
                            line = line.decode("utf-8")
                            if line.startswith("data: "):
                                try:
                                    data_content = line[6:]  # Remove 'data: ' prefix
                                    if data_content.strip() == '[DONE]':
                                        break
                                    if data_content.strip():
                                        data = json.loads(data_content)
                                        if "choices" in data and len(data["choices"]) > 0:
                                            choice = data["choices"][0]
                                            if "delta" in choice and "content" in choice["delta"]:
                                                content = choice["delta"]["content"]
                                                if content:
                                                    yield content
                                            elif choice.get("finish_reason"):
                                                break
                                except json.JSONDecodeError:
                                    print(f"Failed to parse JSON: {line}")
                                except KeyError as e:
                                    print(f"Unexpected data structure: {e}")
                return  # Success, exit retry loop
            except requests.exceptions.RequestException as e:
                print(f"Request attempt {attempt + 1} failed: {e}")
                if attempt == self.valves.RETRY_COUNT:
                    yield f"Error: Request failed after {self.valves.RETRY_COUNT + 1} attempts: {e}"
                else:
                    time.sleep(2 ** attempt)  # Exponential backoff
            except Exception as e:
                print(f"General error in stream_response: {e}")
                yield f"Error: {e}"
                break

    def non_stream_response(self, url: str, headers: Dict[str, str], payload: Dict[str, Any]) -> str:
        """Handle non-streaming response from Docker Model Runner."""
        for attempt in range(self.valves.RETRY_COUNT + 1):
            try:
                response = requests.post(url, headers=headers, json=payload, timeout=(3.05, 60))
                if response.status_code != 200:
                    raise Exception(f"HTTP Error {response.status_code}: {response.text}")

                data = response.json()
                
                # Handle chat completions response
                if "choices" in data and len(data["choices"]) > 0:
                    message = data["choices"][0].get("message", {})
                    return message.get("content", "No response generated")
                
                # Handle other response formats
                return str(data)
                
            except requests.exceptions.RequestException as e:
                print(f"Request attempt {attempt + 1} failed: {e}")
                if attempt == self.valves.RETRY_COUNT:
                    return f"Error: Request failed after {self.valves.RETRY_COUNT + 1} attempts: {e}"
                else:
                    time.sleep(2 ** attempt)  # Exponential backoff
            except Exception as e:
                print(f"General error in non_stream_response: {e}")
                return f"Error: {e}"

    def pipe(self, body: Dict[str, Any]) -> Union[str, Generator, Iterator]:
        """
        Main method for processing requests to Docker Model Runner.
        """
        try:
            # Prepare model ID
            model_id = body.get("model", "")
            model_id = self.process_model_id(model_id)
            
            if not model_id:
                return "Error: No model specified"
            
            # Update the model ID in the request body
            body["model"] = model_id
            
            # Process messages to remove image content if present
            if "messages" in body:
                body["messages"] = self.process_messages(body["messages"])
            
            # Determine the endpoint based on the request
            stream = body.get("stream", False)
            
            # Check if this is a chat completion request
            if "messages" in body:
                endpoint = "/chat/completions"
            elif "input" in body:
                # Embeddings request
                endpoint = "/embeddings"
            elif "prompt" in body:
                # Completion request
                endpoint = "/completions"
            else:
                return "Error: Unable to determine request type"
            
            url = f"{self.get_dmr_url()}{endpoint}"
            headers = {"Content-Type": "application/json"}
            
            if stream and endpoint == "/chat/completions":
                return self.stream_response(url, headers, body)
            else:
                return self.non_stream_response(url, headers, body)
                
        except Exception as e:
            print(f"Error in pipe method: {e}")
            return f"Error: {e}" 
